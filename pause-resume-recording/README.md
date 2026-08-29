# pause-resume-recording

An interactive CLI that opens and closes recording privacy windows mid-meeting with `POST /bots/{bot_id}/pause_recording` and `POST /bots/{bot_id}/resume_recording`.

```bash
npm install && node index.js
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
npm install
cp .env.example .env
```

```env
MEETSTREAM_API_KEY=your_api_key_here
MEETING_LINK=https://meet.google.com/abc-defg-hij
```

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

**Keys do nothing** - stdin is not a TTY. Run it directly in a terminal, not through a pipe or task runner. The log warns when this happens and falls back to `AUTO_SEQUENCE`.

**404 on pause** - the bot is not in a meeting yet, or it already left. Press `t` to check its status; pausing only makes sense once recording has started.

**"Recording is already paused"** - a local guard, not an API error. The CLI tracks its own state so you do not send redundant calls.

**The pause is not in the recording where I expected** - the pause takes effect when the API call lands, not when you pressed the key. For sensitive content, pause *before* the topic starts.

**I quit with `q` and the bot is still recording** - that is what `q` does. Remove it with `GET /bots/{bot_id}/remove_bot` (yes, a GET), or re-run with `BOT_ID` set and press `s`.

## Reference

- [MeetStream docs](https://docs.meetstream.ai)
- [API reference](https://docs.meetstream.ai/api-reference)
