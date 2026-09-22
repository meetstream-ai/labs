# Auto-Join Every Calendar Meeting with a MeetStream Bot

Turn on MeetStream's calendar auto-scheduling so a meeting bot joins every upcoming Zoom, Google Meet or Microsoft Teams meeting on a connected Google or Outlook calendar. One call to `POST /calendar/auto-schedule/enable` with a `default_bot_config`, and the MeetStream API schedules the bots itself, with no per-event API calls. Three commands: `status`, `enable`, `disable`.

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
- A connected calendar. Run [google-calendar-integration](../google-calendar-integration) or [outlook-calendar-integration](../outlook-calendar-integration) first.

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/calendar-auto-schedule
npm install
cp .env.example .env      # fill in MEETSTREAM_API_KEY
node index.js status
```

## Environment variables

Everything except the API key feeds `default_bot_config`, which every auto-scheduled bot inherits.

| Variable | Required | Meaning |
| --- | --- | --- |
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>`. |
| `BOT_NAME` | no | Display name in the meeting. Default `MeetStream Auto Bot`. |
| `VIDEO_REQUIRED` | no | Video is off by default; `true` records video as well as audio. Default `false`. |
| `BOT_MESSAGE` | no | Message the bot posts in the meeting chat when it joins. |
| `BOT_IMAGE_URL` | no | Public image URL for the bot's avatar. |
| `CALLBACK_URL` | no, recommended | Webhook that receives every bot's lifecycle events. Without it you have to poll. |
| `WAITING_ROOM_TIMEOUT` | no | `automatic_leave.waiting_room_timeout`, integer seconds. |
| `NO_ONE_JOINED_TIMEOUT` | no | `automatic_leave.no_one_joined_timeout`, integer seconds. |
| `EVERYONE_LEFT_TIMEOUT` | no | `automatic_leave.everyone_left_timeout`, integer seconds. |
| `VOICE_INACTIVITY_TIMEOUT` | no | `automatic_leave.voice_inactivity_timeout`, integer seconds. |
| `IN_CALL_RECORDING_TIMEOUT` | no | `automatic_leave.in_call_recording_timeout`, integer seconds. API minimum 600. |
| `RECORDING_PERMISSION_DENIED_TIMEOUT` | no | `automatic_leave.recording_permission_denied_timeout`, integer seconds. |
| `TRANSCRIPTION_PROVIDER` | no | Post-call provider: `deepgram`, `assemblyai`, `sarvam`, `jigsawstack` or `meetstream`. Unset: no transcription block. |
| `DEEPGRAM_MODEL` | no | Deepgram model when the provider is `deepgram`. Default `nova-3`. |
| `TRANSCRIPTION_LANGUAGE` | no | Language code for the provider. Default `en`. |
| `MEETSTREAM_API_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |

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

**Recording defaults.** Video is off by default and `video_required: false` is sent explicitly, because the REST API treats an omitted `video_required` as true. `default_bot_config` has no documented `recording_config`, so there is nowhere to send `video_layout`: an auto-scheduled bot with video on gets the API default, `grid_view`. When you want speaker view, schedule that meeting per event with [calendar-schedule-bot](../calendar-schedule-bot), whose `bot_config` does accept `recording_config.video_layout`. Per-participant video (`video_separate_streams`) is never set here.

Documented `default_bot_config` fields: `bot_name`, `audio_required`, `video_required`, `bot_message`, `bot_image_url` and `automatic_leave`. `automatic_leave` accepts `waiting_room_timeout`, `no_one_joined_timeout`, `everyone_left_timeout`, `voice_inactivity_timeout`, `in_call_recording_timeout` and `recording_permission_denied_timeout`, all integer seconds. The calendar examples also carry `callback_url` and a `transcription` block, both of which this template supports through `.env`.

Response: `{ message, auto_schedule_enabled, default_bot_config }`.

### `POST /calendar/auto-schedule/disable`

No body required. This template sends `{}`.

Disabling stops the job creating **new** schedules. Bots already scheduled from earlier runs stay booked, and the template says so when that is the case. Cancel those with the [manage-scheduled-bots](../manage-scheduled-bots) template.

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

For anything happening sooner than the next job run, schedule it by hand with the [calendar-schedule-bot](../calendar-schedule-bot) template. Both mechanisms coexist.

### Overriding one meeting

Auto-join applies `default_bot_config` to everything. To use a different config for a single meeting, schedule that event manually with `POST /calendar/schedule/{event_id}` and its own `bot_config`. Because the manual bot lands first, the auto-schedule job skips that event.

## Cost and privacy

Auto-join means a bot in **every** meeting with a link, including one to one calls, interviews and anything personal that lands on the connected calendar. Two things worth doing before you enable it on a real calendar:

- Check local recording consent requirements. `bot_message` posts a notice in the meeting chat on join.
- Remember that every joined meeting is billable time. `node index.js status` shows what is queued, and `disable` stops the queue growing.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `MEETSTREAM_API_KEY is not set` | No `.env`, or an empty key. | `cp .env.example .env` and paste your key. |
| API error 401 / 403 | No key was sent, or the key was rejected. | Check `.env` is loaded from the directory you ran `node` in; copy the whole key. |
| API error 400 on enable | A `default_bot_config` value is malformed. Timeouts must be integers in seconds; `in_call_recording_timeout` has a 600 second minimum. | Fix the value in `.env`. |
| API error 404 on `status` | No calendar is connected for this workspace. | Run the Google or Outlook calendar template first. |
| Enabled, but no bots appear | Expected within the first 24 hours. The job has not run yet, or the next 24 hours holds no meetings with links. | Check `node index.js status`; schedule anything urgent with `calendar-schedule-bot`. |
| Some meetings never get a bot | They have no detected meeting link, or they already had a bot. | [calendar-event-sync](../calendar-event-sync) shows both. |
| Bots join meetings you did not want | Auto-join has no filter. | Disable it and schedule the meetings you want individually. |
| Settings do not match what you sent | Someone changed the **Auto-schedule bots** toggle on the dashboard's Calendar page. | `GET .../settings` is the source of truth; re-run `enable`. |
| Disabled but bots still join | Those were scheduled before you disabled. | Cancel them with [manage-scheduled-bots](../manage-scheduled-bots). |

## Related

- [Scheduling bots](https://docs.meetstream.ai/guides/features/scheduling-bots)
- [Google Calendar OAuth setup](https://docs.meetstream.ai/guides/calendar-integrations/google-calendar-oauth-setup)
- [Outlook Calendar setup](https://docs.meetstream.ai/guides/calendar-integrations/outlook-calendar-setup)
- [Setup Cron (enable)](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/setup-cron)
- [Disable Cron (disable)](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/disable-cron)
- [Get auto-schedule settings](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/get-auto-schedule-settings)
- [List scheduled bots](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/list-scheduled-bots)
- [Automatic leave configuration](https://docs.meetstream.ai/guides/features/automatic-leave-configuration)
- Sibling templates: [google-calendar-integration](../google-calendar-integration), [outlook-calendar-integration](../outlook-calendar-integration), [calendar-schedule-bot](../calendar-schedule-bot), [manage-scheduled-bots](../manage-scheduled-bots), [calendar-recurring-events](../calendar-recurring-events)
