# calendar-event-sync

Sync upcoming events from a connected calendar with `GET /calendar/events`, detect which ones carry a joinable meeting link, and print a schedule table.

```bash
npm install
cp .env.example .env      # fill in MEETSTREAM_API_KEY
node index.js
```

## What it does

1. Calls `GET /calendar/events` with a time window. That endpoint syncs from the upstream provider first (Google Calendar or Microsoft Graph, incremental where possible), stores the events, and returns them with pagination.
2. Follows the `next` cursor until the window is exhausted or `SYNC_MAX_EVENTS` is reached.
3. Classifies every event: which conferencing platform, whether a bot could join at all, and whether a bot is already scheduled.
4. Prints a sorted table.

## Prerequisites

- Node.js 18 or newer.
- A MeetStream API key from <https://app.meetstream.ai>.
- A connected calendar. Run the `google-calendar-integration` or `outlook-calendar-integration` template first.

## Usage

```bash
node index.js                       # next 14 days, table output
node index.js --days 30             # widen the window
node index.js --with-links          # only events a bot could actually join
node index.js --json                # raw event objects
node index.js --limit 100           # 100 events per page (API max)
node index.js --no-sync             # skip the upstream sync, read what is stored
node index.js --calendar-id team-meetings@group.calendar.google.com
node index.js --provider outlook --account-id jane@acme.com
```

Example output:

```
Syncing events for the next 14 day(s)...

START             PLATFORM         BOT         EVENT ID                TITLE
----------------  ---------------  ----------  ----------------------  ----------------------------------------
2026-04-08 09:00  Google Meet      Scheduled   evt_9198b1f67bb94e7e    Weekly Standup
2026-04-08 11:30  Zoom             -           evt_2a1179ef047a5285    Customer discovery: Acme
2026-04-09 14:00  no link          -           evt_71c0d4ab19ee3310    Focus block
2026-04-10 16:00  Microsoft Teams  -           evt_ba55cf20a1b74e91    Partner sync

4 event(s) synced
3 with a joinable meeting link
1 without a link (a bot cannot join these)
1 already have a bot scheduled

To put a bot on the next unscheduled meeting, use the
calendar-schedule-bot template with EVENT_ID=evt_2a1179ef047a5285
```

## How it works

### `GET /calendar/events`

Query parameters used here:

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `calendar_id` | string | primary calendar | Sync one specific calendar |
| `time_min` | ISO 8601 | now minus 1 day | Start of the window |
| `time_max` | ISO 8601 | now plus 28 days | End of the window |
| `sync` | `"true"` / `"false"` | auto | Force or skip the upstream sync |
| `limit` | int, 1 to 100 | 50 | Page size |
| `cursor` | string | none | The `next` value from the previous page |
| `provider` | string | all | `google` or `outlook`, multi-account users |
| `account_id` | string | all | Requires `provider` |

Response shape:

```json
{
  "next": "eyJFdmVudElEIjogIm...",
  "previous": null,
  "has_more": true,
  "results": [
    {
      "id": "evt_abc123",
      "start_time": "2026-04-08T15:00:00Z",
      "end_time": "2026-04-08T16:00:00Z",
      "calendar_id": "jane@example.com",
      "platform": "google_calendar",
      "platform_id": "google_evt_456",
      "ical_uid": "abc123@google.com",
      "meeting_platform": "GMeet",
      "meeting_url": "https://meet.google.com/abc-defg-hij",
      "is_deleted": false,
      "created_at": "...",
      "updated_at": "...",
      "raw": { },
      "bots": [
        {
          "id": "bot_111",
          "status": "Scheduled",
          "scheduled_join_time": "2026-04-08T14:59:00+00:00",
          "bot_username": "MeetStream Calendar Bot",
          "platform": "GMeet",
          "is_scheduled": true
        }
      ]
    }
  ]
}
```

Two fields matter more than the rest:

- **`id`** is the MeetStream event id. It is what `POST /calendar/schedule/{event_id}` takes, not the provider's own event id (`platform_id`).
- **`meeting_url`** is what decides whether a bot can join. MeetStream detects Google Meet, Zoom, Microsoft Teams, Webex, GoToMeeting, BlueJeans and Whereby links inside events. An event without a detected link cannot be scheduled, and auto-scheduling skips it.

### Pagination

The loop follows `next` while `has_more` is true. It also stops if a page comes back empty or if `has_more` is true without a usable `next`, so a bad cursor cannot spin forever. A 20 page hard cap backs that up.

### Platform detection

`meeting_platform` from the API is preferred and mapped to a readable label (`GMeet` becomes `Google Meet`). If the field is absent the template falls back to matching the `meeting_url` host, which keeps the output useful for link types the label does not cover.

### Titles

Event titles live in `raw`, the untouched provider payload. Google Calendar puts it in `raw.summary`, Microsoft Graph in `raw.subject`. The template reads both and falls back to `(untitled)`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| API error 401 | `MEETSTREAM_API_KEY` is not set. |
| API error 403 | The API key was rejected. |
| Empty results | No calendar is connected. Check with `GET /calendar`, or run the integration template. Otherwise widen the window with `--days 30`. |
| Everything shows "no link" | The events genuinely have no conferencing link. MeetStream reads the link out of the event body and location, so a link typed into a description as plain text may not be detected. |
| Events you deleted still appear | A sync page can include tombstones. This template filters on `is_deleted`. |
| Slow first run | The first sync pulls the full window from the provider. Later runs are incremental. `--no-sync` skips the upstream call entirely. |

## Related templates

- `google-calendar-integration` / `outlook-calendar-integration` connect the calendar.
- `calendar-schedule-bot` schedules a bot for one of these events.
- `calendar-auto-schedule` schedules every event with a link automatically.
- `manage-scheduled-bots` lists and edits the bots that come out of scheduling.
