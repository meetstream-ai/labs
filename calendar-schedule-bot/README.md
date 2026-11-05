# Schedule a MeetStream Bot for One Calendar Event

Schedule a MeetStream meeting bot for a single Zoom, Google Meet or Microsoft Teams event on a connected Google or Outlook calendar with `POST /calendar/schedule/{event_id}`, handle the 409 duplicate case gracefully, and remove it again with `DELETE /calendar/schedule/{event_id}`. Use it when you want a custom `bot_config` for one meeting instead of calendar-wide auto-join.

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
- A connected calendar with at least one upcoming event that has a meeting link. Use [google-calendar-integration](../google-calendar-integration) or [outlook-calendar-integration](../outlook-calendar-integration), then [calendar-event-sync](../calendar-event-sync) to see event ids.

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/calendar-schedule-bot
npm install
cp .env.example .env      # fill in MEETSTREAM_API_KEY
node index.js schedule
```

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>`. |
| `EVENT_ID` | no | MeetStream event id (the `id` from `GET /calendar/events`). Unset: the CLI argument, else the soonest schedulable event. |
| `BOT_NAME` | no | Display name in the meeting. Default `MeetStream Calendar Bot`. |
| `VIDEO_REQUIRED` | no | Video is off by default; `true` records video as well as audio. Default `false`. |
| `VIDEO_LAYOUT` | no | Only read when `VIDEO_REQUIRED=true`. `speaker_view` (default) or `grid_view`. The API default is `grid_view`, so speaker view is sent explicitly. |
| `BOT_MESSAGE` | no | Message the bot posts in the meeting chat when it joins. |
| `CALLBACK_URL` | no | Per-bot webhook for lifecycle events. |
| `NO_ONE_JOINED_TIMEOUT` | no | `automatic_leave.no_one_joined_timeout`, seconds. Calendar-only field. |
| `EVERYONE_LEFT_TIMEOUT` | no | `automatic_leave.everyone_left_timeout`, seconds. |
| `WAITING_ROOM_TIMEOUT` | no | `automatic_leave.waiting_room_timeout`, seconds. |
| `TRANSCRIPTION_PROVIDER` | no | Post-call provider: `deepgram`, `assemblyai`, `sarvam`, `jigsawstack` or `meetstream`. Unset: no transcription. |
| `DEEPGRAM_MODEL` | no | Deepgram model when the provider is `deepgram`. Default `nova-3`. |
| `TRANSCRIPTION_LANGUAGE` | no | Language code for the provider. Default `en`. |
| `DEDUPLICATION_KEY` | no | Your own `deduplication_key`. A replay returns the existing bot; reusing it against a different meeting URL returns 409. |
| `RECURRING_EVENT` | no | `true` auto-schedules the next occurrence of a series after each meeting. Default `false`. |
| `CANCEL_ALL_OCCURRENCES` | no | `unschedule` only: `true` cancels the whole series. Default `false`. |
| `CANCEL_FROM_DATE` | no | `unschedule` only: ISO 8601, cancel occurrences from this date on. |
| `MEETSTREAM_API_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |

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

**Recording defaults.** Video is off by default and `video_required: false` is sent explicitly, because the REST API treats an omitted `video_required` as true. With `VIDEO_REQUIRED=true` the template also sends `recording_config.video_layout: "speaker_view"`, because the API default is `grid_view`; set `VIDEO_LAYOUT=grid_view` only when you want the mosaic of everyone. Per-participant video (`video_separate_streams`) is never set here.

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

To change an existing scheduled bot, do not re-schedule. Use `PATCH /calendar/scheduled_bots/{bot_id}` (the [manage-scheduled-bots](../manage-scheduled-bots) template) or unschedule and schedule again.

### `DELETE /calendar/schedule/{event_id}`

Optional body:

```json
{ "cancel_all_occurrences": false, "from_date": "2026-05-01T00:00:00Z" }
```

Response: `{ unscheduled, event_id, cancelled_schedules, schedules_cancelled, bots_deleted, cancel_all_occurrences, is_recurring_series }`.

### Join timing

Scheduled bots join **1 minute before** the meeting's start time. If you move the meeting in your calendar, MeetStream picks that up through its push notification channel and updates the join time automatically. If you delete the meeting, the bot is cancelled.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `MEETSTREAM_API_KEY is not set` | No `.env`, or an empty key. | `cp .env.example .env` and paste your key. |
| API error 401 / 403 | No key was sent, or the key was rejected. | Check `.env` is loaded from the directory you ran `node` in; copy the whole key. |
| "No upcoming event found..." | Every upcoming event either lacks a meeting link or already has a bot. | Run [calendar-event-sync](../calendar-event-sync) to check, or pass an event id explicitly. |
| API error 404 | Wrong event id, or no calendar connected. | Use the `id` field from `GET /calendar/events`, not `platform_id` or the Google/Outlook event id. |
| API error 409 | Already scheduled. Expected, and handled: the existing bot id is printed. | Use [manage-scheduled-bots](../manage-scheduled-bots) to edit the existing bot, or `unschedule` first. |
| API error 400 | Usually a bad `bot_config` value. Timeouts must be integers in seconds. | Check the transcription provider name and the timeout values in `.env`. |
| Bot never joined | The event no longer exists or lost its link. A cancelled meeting cancels the bot. | Check `GET /calendar/scheduled_bots` for its status. |
| Scheduled a past meeting | MeetStream deletes schedules whose time has moved into the past. | Pick a future event. |

## Related

- [Schedule event](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/schedule-event)
- [Remove schedule event](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/remove-schedule-event)
- [Fetch sync events](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/fetch-sync-events)
- [List scheduled bots](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/list-scheduled-bots)
- [Toggle recurring event](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/toggle-recurring-event)
- [Scheduling bots](https://docs.meetstream.ai/guides/features/scheduling-bots)
- [Automatic leave configuration](https://docs.meetstream.ai/guides/features/automatic-leave-configuration)
- Sibling templates: [calendar-event-sync](../calendar-event-sync) finds event ids; [manage-scheduled-bots](../manage-scheduled-bots) lists, reschedules and cancels bots; [calendar-recurring-events](../calendar-recurring-events) covers series and occurrences; [calendar-auto-schedule](../calendar-auto-schedule) schedules everything automatically.
