# calendar-schedule-bot

Schedule a MeetStream bot for one specific calendar event with `POST /calendar/schedule/{event_id}`, handle the 409 duplicate case gracefully, and remove it again with `DELETE /calendar/schedule/{event_id}`.

```bash
npm install
cp .env.example .env      # fill in MEETSTREAM_API_KEY
node index.js schedule
```

## What it does

1. Resolves an event: the CLI argument, then `EVENT_ID` from `.env`, otherwise the soonest upcoming event that has a meeting link and no bot yet.
2. Builds a `bot_config` from your environment and posts it to `POST /calendar/schedule/{event_id}`.
3. If MeetStream returns **409 Conflict**, that means a bot is already booked for the event. The template prints the existing bot id and what to do next instead of failing.
4. `node index.js unschedule <eventId>` removes it.

## Prerequisites

- Node.js 18 or newer.
- A MeetStream API key from <https://app.meetstream.ai>.
- A connected calendar with at least one upcoming event that has a meeting link. Use `google-calendar-integration` or `outlook-calendar-integration`, then `calendar-event-sync` to see event ids.

## Usage

```bash
node index.js                          # same as `schedule`
node index.js schedule                 # auto-picks the next schedulable event
node index.js schedule evt_abc123      # schedule a specific event
node index.js status evt_abc123        # show the bots attached to an event
node index.js unschedule evt_abc123    # cancel the scheduled bot
```

Example:

```
Scheduling a bot for event evt_2a1179ef047a5285
  Title      : Customer discovery: Acme
  Starts     : 2026-04-08T11:30:00Z
  Platform   : zoom
  Meeting url: https://us02web.zoom.us/j/8123456789

bot_config:
{
  "bot_name": "MeetStream Calendar Bot",
  "audio_required": true,
  "video_required": false
}

Scheduled.
  Bot id          : bot_111aaa12
  Schedule id     : bot-usr_abc1-bot_111aaa12
  Joins at        : 2026-04-08T11:29:00Z
  Schedule group  : zoom
  Recurring       : false

The bot joins 1 minute before the meeting starts.
To cancel:  node index.js unschedule evt_2a1179ef047a5285
```

## How it works

### `POST /calendar/schedule/{event_id}`

`event_id` is the **MeetStream** event id, the `id` field from `GET /calendar/events`. It is not the provider's own event id, which appears separately as `platform_id`.

```json
{
  "bot_config": {
    "bot_name": "MeetStream Calendar Bot",
    "audio_required": true,
    "video_required": false,
    "bot_message": "Recording this meeting for notes.",
    "callback_url": "https://your-domain.com/webhooks/meetstream",
    "automatic_leave": { "no_one_joined_timeout": 300, "everyone_left_timeout": 60 }
  },
  "recurring_event": false
}
```

Body fields outside `bot_config`:

| Field | Type | Default | Description |
|---|---|---|---|
| `occurrence_date` | ISO 8601 | none | Schedule one specific occurrence of a recurring event |
| `schedule_all_occurrences` | bool | `false` | Schedule every future occurrence at once |
| `occurrence_limit` | int | 52 | Cap when using `schedule_all_occurrences` |
| `recurring_event` | bool | `false` | After this occurrence, auto-schedule the next one |

Response: `{ scheduled, schedule_id, bot_id, schedule_group, event_id, scheduled_time, existing_schedules, occurrence_date, is_recurring_occurrence, bot_config }`.

### The `bot_config` shape

Calendar `bot_config` accepts what `create_bot` accepts, plus `audio_required`, which `create_bot` does not have (`create_bot` always captures audio, so the field is meaningless there).

The documented calendar fields are `bot_name`, `bot_message`, `bot_image_url`, `audio_required`, `video_required`, `callback_url`, `meeting_url`, `join_at`, `deduplication_key`, `automatic_leave`, `recording_config`, `custom_attributes`, `live_audio_required` and `live_transcription_required`.

One shape difference worth knowing: in the calendar examples the transcription provider goes under a top level **`transcription`** key:

```json
"transcription": { "deepgram": { "model": "nova-3", "language": "en" } }
```

whereas `create_bot` nests it as `recording_config.transcript.provider.deepgram`. This template follows the calendar shape and leaves transcription **off by default**. Set `TRANSCRIPTION_PROVIDER` in `.env` to turn it on.

`automatic_leave` here also accepts `no_one_joined_timeout`, which has no `create_bot` equivalent. All timeouts are integer seconds.

### The 409

Scheduling the same event twice returns **409 Conflict** with the existing bot's id. This is deduplication working, not an error: MeetStream will not put two bots in one meeting.

The template passes 409 through as an expected status rather than throwing:

```js
return call(`/calendar/schedule/${eventId}`, { method: "POST", body, accept: [409] });
```

To change an existing scheduled bot, do not re-schedule. Use `PATCH /calendar/scheduled_bots/{bot_id}` (the `manage-scheduled-bots` template) or unschedule and schedule again.

### `DELETE /calendar/schedule/{event_id}`

Optional body:

```json
{ "cancel_all_occurrences": false, "from_date": "2026-05-01T00:00:00Z" }
```

Response: `{ unscheduled, event_id, cancelled_schedules, schedules_cancelled, bots_deleted, cancel_all_occurrences, is_recurring_series }`.

### Join timing

Scheduled bots join **1 minute before** the meeting's start time. If you move the meeting in your calendar, MeetStream picks that up through its push notification channel and updates the join time automatically. If you delete the meeting, the bot is cancelled.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "No upcoming event found..." | Every upcoming event either lacks a meeting link or already has a bot. Run `calendar-event-sync` to check, or pass an event id explicitly. |
| API error 404 | Wrong event id. Use the `id` field from `GET /calendar/events`, not `platform_id` or the Google/Outlook event id. |
| API error 409 | Already scheduled. Expected, and handled. Use `manage-scheduled-bots` to edit the existing bot. |
| API error 400 | Usually a bad `bot_config` value. Timeouts must be integers in seconds. Check the transcription provider name. |
| API error 401 / 403 | `MEETSTREAM_API_KEY` missing or rejected. |
| Bot never joined | Check the event still exists and still has a link, and check `GET /calendar/scheduled_bots` for its status. A cancelled meeting cancels the bot. |
| Scheduled a past meeting | MeetStream deletes schedules whose time has moved into the past. Pick a future event. |

## Related templates

- `calendar-event-sync` finds event ids.
- `manage-scheduled-bots` lists, reschedules and cancels bots after scheduling.
- `calendar-recurring-events` covers series, occurrences and auto-rescheduling.
- `calendar-auto-schedule` schedules everything automatically instead of one at a time.
