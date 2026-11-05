# Pause and Resume Meeting Recording with the MeetStream API

An interactive CLI that opens and closes recording privacy windows mid-meeting on Zoom, Google Meet or Microsoft Teams, using the MeetStream API's `POST /bots/{bot_id}/pause_recording` and `POST /bots/{bot_id}/resume_recording`. The bot stays in the call; only capture stops, and the gap is simply absent from the recording.

```bash
npm install && cp .env.example .env && node index.js
```

## The privacy window

A meeting bot that cannot be paused is a compliance problem. Real meetings contain stretches that must not end up in a recording:

- **Salary, performance, or HR discussion** at the end of a team call.
- **Legal or privileged conversation** - counsel joins for ten minutes, then leaves.
- **Payment details read aloud**, or any PCI/PHI/PII spoken in passing.
- **A participant who declines to be recorded** joining partway through, where consent is per-person rather than per-meeting.
- **Break time**, when people forget the bot is still listening.

Pausing keeps the bot **in the meeting** - it stays connected, keeps its seat, keeps its session, and can still receive control calls. Only capture stops. That matters, because dropping the bot and re-inviting it produces two disjoint recordings, loses the join sequence, and often needs the host to admit it again from the waiting room.

The gap is simply absent from the finished recording. Nothing is stored and later filtered, so there is no copy to subpoena, leak, or forget to delete.

**Operational rule: pause is not consent.** Announce the pause in the meeting, resume audibly, and keep a record of both. This template prints an audit trail of every pause and resume with timestamps and window durations when it exits.

## What it does

1. Creates a bot (or attaches to one you already have via `BOT_ID`).
2. Puts your terminal into single-keypress mode.
3. Sends pause/resume/remove calls on keypress and logs every one.
4. Prints a privacy-window audit trail on exit.

```
  p  pause recording   (privacy window opens)
  r  resume recording  (privacy window closes)
  t  show bot status
  s  stop: remove the bot from the meeting and exit
  ?  show this help
  q  quit this CLI and LEAVE the bot running in the meeting
```

## Prerequisites

- Node.js 18 or newer (uses built-in `fetch`)
- A MeetStream API key: https://app.meetstream.ai
- A meeting link, or the `bot_id` of a bot already in a meeting

No webhooks, no tunnel, no public URL.

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/pause-resume-recording
npm install
cp .env.example .env
```

```env
MEETSTREAM_API_KEY=your_api_key_here
MEETING_LINK=https://meet.google.com/abc-defg-hij
```

## Environment variables

| Name | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | API key from <https://app.meetstream.ai>, sent as `Authorization: Token <key>`. |
| `MEETING_LINK` | one of | Start a new bot in this Zoom, Google Meet or Teams meeting. |
| `BOT_ID` | one of | Control a bot that is already in a meeting instead. |
| `BOT_NAME` | no | Display name in the meeting. Default `MeetStream Recorder`. |
| `VIDEO_REQUIRED` | no | Video is off by default. `true` records video as well as audio. Default `false`. |
| `VIDEO_LAYOUT` | no | Only read when `VIDEO_REQUIRED=true`. `speaker_view` (the default) or `grid_view`. The API default is `grid_view`, so speaker view is always sent explicitly. |
| `EVERYONE_LEFT_TIMEOUT` | no | Seconds the bot waits after everyone else leaves. Default `60`. |
| `AUTO_SEQUENCE` | no | Scripted `<seconds>:<pause|resume|stop>` list used only when stdin is not a TTY. Default `30:pause,60:resume,90:stop`. |
| `REQUEST_TIMEOUT_MS` | no | Per-request timeout. Default `30000`. |
| `MAX_RETRIES` | no | Retries on 429 / 5xx. Default `4`. |
| `LOG_LEVEL` | no | `silent`, `error`, `warn`, `info` or `debug`. Default `info`. |

**Recording defaults.** Pause and resume work the same for an audio-only bot, so this template now creates one: it sends `video_required: false` explicitly, because the REST API treats an omitted `video_required` as true. Set `VIDEO_REQUIRED=true` to record video too, and the template also sends `recording_config.video_layout: "speaker_view"` since the API default is `grid_view`. Per-participant video (`video_separate_streams`) is never set here.

## Run

```bash
node index.js
```

Sample session:

```
10:14:02  INFO Bot created: bot_id=bot_abc123 status=joining
10:14:02  INFO Recording control ready.

  p  pause recording   (privacy window opens)
  ...

10:19:40  INFO PAUSED - the bot is still in the meeting, but nothing is being recorded.
10:22:05  INFO RESUMED - recording again.
10:31:12  INFO Bot asked to leave the meeting.

Recording control audit trail
bot_id: bot_abc123
  2026-08-23T17:19:40.118Z  ok    pause  Recording paused.
  2026-08-23T17:22:05.902Z  ok    resume Recording resumed.
      -> privacy window of 145s is absent from the recording
  2026-08-23T17:31:12.441Z  ok    stop   Bot removed from meeting.
```

## How it works

### The API calls

Both endpoints take an **empty body** - no JSON payload at all:

```
POST /bots/{bot_id}/pause_recording
POST /bots/{bot_id}/resume_recording
Authorization: Token <your key>
```

The header is literally `Token`, not `Bearer`. Errors come back as `{ "message": "..." }`, and that message is what the CLI prints when a call fails.

| Status | Meaning | Behaviour |
|---|---|---|
| 200 / 201 | Applied | Update local state, log it |
| 404 | Unknown bot, or it already left | Surfaced with the API's message |
| 429, 5xx | Transient | Retry with exponential backoff |
| **507** | **Idempotent replay** | **Treated as success** |

A failed pause never flips the local state to "paused" - if you cannot prove the pause landed, you must assume it did not.

### Raw mode and Ctrl+C

Single-keypress input requires raw terminal mode, which also stops the terminal turning Ctrl+C into SIGINT. The CLI therefore handles `ctrl+c` as a keypress and removes the bot before exiting, so you never leave an orphan bot recording in someone's meeting. Raw mode is always restored on exit.

### Non-interactive fallback

Under CI, `nohup`, or piped input there is no TTY and single-key control is impossible. In that case the CLI runs the scripted sequence in `AUTO_SEQUENCE` instead (default `30:pause,60:resume,90:stop`) so the template is still demonstrable and testable.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing required environment variable "MEETSTREAM_API_KEY"` | `.env` not created or key blank | `cp .env.example .env` and fill it in. |
| `Set MEETING_LINK ... or BOT_ID` | Neither was provided | Set exactly one of them. |
| HTTP 401 / 403 | Key missing or rejected | The header must be `Authorization: Token <key>`; regenerate the key if needed. |
| Keys do nothing | stdin is not a TTY | Run directly in a terminal, not through a pipe or task runner. The CLI warns and falls back to `AUTO_SEQUENCE`. |
| 404 on pause | Bot is not in a meeting yet, or already left | Press `t` to check status; pause only once recording has started. |
| HTTP 429 or 5xx | Transient | Retried with exponential backoff up to `MAX_RETRIES`. |
| HTTP 507 | Idempotent replay | Treated as success, never retried. |
| `Recording is already paused` | Local guard, not an API error | The CLI tracks its own state to avoid redundant calls. |
| Pause is not where you expected in the recording | It takes effect when the API call lands, not on keypress | Pause before the sensitive topic starts. |
| Quit with `q` and the bot is still recording | That is what `q` does | Remove it with `GET /bots/{bot_id}/remove_bot` (a GET), or re-run with `BOT_ID` set and press `s`. |

## Related

- [Pause and resume recording](https://docs.meetstream.ai/guides/features/pause-resume-recording)
- [Pause bot recording](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/pause-bot-recording)
- [Resume bot recording](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/resume-bot-recording)
- [Remove bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/remove-bot)
- [Get bot status](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-status)
- [Error codes](https://docs.meetstream.ai/errors)
- Labs: [websocket-bot-control](../websocket-bot-control), [bot-status-monitor](../bot-status-monitor), [list-and-manage-bots](../list-and-manage-bots)
