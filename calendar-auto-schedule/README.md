# calendar-auto-schedule

The "a bot joins all my meetings automatically" template. One call to `POST /calendar/auto-schedule/enable` and every upcoming meeting with a link gets a bot, with no per-event API calls.

```bash
npm install
cp .env.example .env      # fill in MEETSTREAM_API_KEY
node index.js enable
node index.js status
```

## What it does

| Command | Endpoint | Effect |
|---|---|---|
| `node index.js status` | `GET /calendar/auto-schedule/settings` plus `GET /calendar/scheduled_bots` | Shows whether auto-join is on, the config in force, and the bots on the books |
| `node index.js enable` | `POST /calendar/auto-schedule/enable` | Turns it on with a `default_bot_config` built from `.env` |
| `node index.js disable` | `POST /calendar/auto-schedule/disable` | Turns it off |

## A note on "setup-cron"

The API reference has pages titled **Setup Cron** and **Disable Cron**. Those pages document `POST /calendar/auto-schedule/enable` and `POST /calendar/auto-schedule/disable`. There is no separate `/calendar/setup-cron` path to call. The "cron" is the background job that these two endpoints switch on and off, and it is entirely server side, so there is nothing to install or host yourself.

## Prerequisites

- Node.js 18 or newer.
- A MeetStream API key from <https://app.meetstream.ai>.
- A connected calendar. Run `google-calendar-integration` or `outlook-calendar-integration` first.

## Usage

```bash
node index.js enable
```

```
Enabling auto-scheduling with default_bot_config:
{
  "bot_name": "MeetStream Auto Bot",
  "audio_required": true,
  "video_required": false,
  "callback_url": "https://your-domain.com/webhooks/meetstream"
}

Enabled.
  Auto-scheduling enabled successfully
  auto_schedule_enabled: true

What happens now:
  - A background job runs every 24 hours at midnight UTC.
  - It scans the next 24 hours of events for a valid meeting link.
  - Events that already have a bot are skipped, so this composes safely
    with anything you scheduled by hand.
  - Each bot joins 1 minute before its meeting starts.
  - Events with no meeting link are skipped entirely.
```

## How it works

### `POST /calendar/auto-schedule/enable`

```json
{
  "default_bot_config": {
    "bot_name": "MeetStream Auto Bot",
    "audio_required": true,
    "video_required": false,
    "callback_url": "https://your-domain.com/webhooks/meetstream",
    "automatic_leave": { "no_one_joined_timeout": 600, "everyone_left_timeout": 300 }
  }
}
```

Documented `default_bot_config` fields: `bot_name`, `audio_required`, `video_required`, `bot_message`, `bot_image_url` and `automatic_leave`. `automatic_leave` accepts `waiting_room_timeout`, `no_one_joined_timeout`, `everyone_left_timeout`, `voice_inactivity_timeout`, `in_call_recording_timeout` and `recording_permission_denied_timeout`, all integer seconds. The calendar examples also carry `callback_url` and a `transcription` block, both of which this template supports through `.env`.

Response: `{ message, auto_schedule_enabled, default_bot_config }`.

### `POST /calendar/auto-schedule/disable`

No body required. This template sends `{}`.

Disabling stops the job creating **new** schedules. Bots already scheduled from earlier runs stay booked, and the template says so when that is the case. Cancel those with the `manage-scheduled-bots` template.

### `GET /calendar/auto-schedule/settings`

Returns `{ auto_schedule_enabled, default_bot_config }`. Use it to confirm what config is actually in force, which is not always what you last sent if someone also flipped the toggle in the dashboard.

### The job's actual behaviour

This is the part that surprises people:

- The job runs **once every 24 hours, at midnight UTC**. Enabling auto-join at 09:00 does not backfill bots for that morning.
- It only looks **24 hours ahead**. A meeting three days out gets its bot on the run that falls within a day of it, not today.
- It **skips events that already have a bot**, using deduplication keys. Manual scheduling and auto-join do not fight each other.
- Bots join **1 minute before** the start time.
- Events **without a detected meeting link are skipped**. There is nothing for a bot to join.
- Calendar edits are handled in real time by push notifications, independently of this job. Move a meeting and the bot's join time moves. Cancel it and the bot is cancelled.

For anything happening sooner than the next job run, schedule it by hand with the `calendar-schedule-bot` template. Both mechanisms coexist.

### Overriding one meeting

Auto-join applies `default_bot_config` to everything. To use a different config for a single meeting, schedule that event manually with `POST /calendar/schedule/{event_id}` and its own `bot_config`. Because the manual bot lands first, the auto-schedule job skips that event.

## Cost and privacy

Auto-join means a bot in **every** meeting with a link, including one to one calls, interviews and anything personal that lands on the connected calendar. Two things worth doing before you enable it on a real calendar:

- Check local recording consent requirements. `bot_message` posts a notice in the meeting chat on join.
- Remember that every joined meeting is billable time. `node index.js status` shows what is queued, and `disable` stops the queue growing.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Enabled, but no bots appear | Expected within the first 24 hours. The job has not run yet, or the next 24 hours holds no meetings with links. Check `node index.js status`. |
| Some meetings never get a bot | They have no detected meeting link, or they already had a bot. `calendar-event-sync` shows both. |
| Bots join meetings you did not want | Auto-join has no filter. Disable it and schedule the meetings you want individually. |
| API error 401 / 403 | `MEETSTREAM_API_KEY` missing or rejected. |
| API error 400 on enable | A `default_bot_config` value is malformed. Timeouts must be integers in seconds. |
| Settings do not match what you sent | Someone changed the **Auto-schedule bots** toggle on the dashboard's Calendar page. `GET .../settings` is the source of truth. |
| Disabled but bots still join | Those were scheduled before you disabled. Cancel them with `manage-scheduled-bots`. |

## Related templates

- `google-calendar-integration` / `outlook-calendar-integration` connect the calendar first.
- `calendar-schedule-bot` schedules one event with a custom config.
- `manage-scheduled-bots` lists and cancels the bots auto-join creates.
- `calendar-recurring-events` handles recurring series specifically.
