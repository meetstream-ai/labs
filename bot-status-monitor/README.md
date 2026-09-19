# bot-status-monitor

Poll `GET /bots/{id}/status` and `GET /bots/{id}/detail` and render the bot lifecycle as a live timeline in your terminal, with every `bot_status` value explained.

```bash
npm install
cp .env.example .env   # then fill in MEETSTREAM_API_KEY
node index.js <bot_id>
```

## Prerequisites

- Node.js 18 or newer
- A MeetStream API key from https://app.meetstream.ai
- A bot id, or a `MEETING_LINK` so the template can create one for you

## Usage

```bash
node index.js                  # monitors BOT_ID, or creates a bot from MEETING_LINK
node index.js bot_abc123       # monitors a specific bot
node index.js --explain        # prints the status reference and exits (no API key needed)
node index.js bot_abc123 --raw # dumps the raw detail payload when the session ends
```

## What the timeline shows

The view has three parts.

**Expected path** is the happy-path scaffold. `x` means the state was observed, `>` marks the current state, `.` means it has not happened (or was skipped, which is normal: a bot admitted instantly never reports `InWaitingRoom`).

**Observed** is what actually happened, with the wall-clock time each state was first seen and how long it was held.

**Detail** is a filtered view of `GET /bots/{id}/detail`: platform, timings, `transcript_id`, and so on. Fields absent from the payload are simply skipped rather than printed as `undefined`.

When stdout is a TTY the whole view redraws in place. When it is piped or redirected, output falls back to append-only log lines, so `node index.js bot_x > run.log` produces a sensible log.

## Every bot_status value

| bot_status | Webhook event | Terminal | Meaning |
|---|---|---|---|
| `Joining` | `bot.joining` | no | Dispatched, dialling into the meeting |
| `InWaitingRoom` | `bot.in_waiting_room` | no | In the lobby waiting to be admitted |
| `InMeeting` | `bot.inmeeting` | no | Admitted and present as a participant |
| `Recording` | `bot.recording` | no | Capture is running |
| `Leaving` | `bot.leaving` | no | Shutting down and exiting |
| `Stopped` | `bot.stopped` (`bot_event` `bot.stopped` or `bot.kicked`) | yes | Ended normally, or a participant removed the bot |
| `NotAllowed` | `bot.stopped` (`bot_event` `bot.notallowed`) | yes | Waiting-room timeout, never admitted |
| `Denied` | `bot.stopped` (`bot_event` `bot.denied`) | yes | A host denied the bot |
| `Error` (also `FAILED`, `ERROR`, `Failed`) | `bot.stopped` (`bot_event` `bot.failed`) | yes | The session failed |
| `Done` | `bot.done` | yes | Session finished, post-processing complete |

The monitor matches `bot_status` case-insensitively, because the failure value arrives in varying case.

Run `node index.js --explain` for the long-form version plus the post-session webhook events (`manifest.completed`, `audio.processed`, `transcription.processed`, `video.processed`, `bot.done`, `data_deletion`).

## Four things that catch people out

1. Every webhook carries `event`, and most also carry `bot_event`. They differ only on terminals: every ending arrives as `event: "bot.stopped"` with the reason in `bot_event` (`bot.stopped`, `bot.kicked`, `bot.notallowed`, `bot.denied`, `bot.failed`). `bot_status` cannot tell a kick from a clean exit (both are `Stopped`), so use a webhook's `bot_event` when the exact reason matters.
2. `bot.stopped` arrives with `status_code: 200` for a clean exit or a kick, and `500` for `NotAllowed`, `Denied` and most failures. Branch on `bot_event`, not the status code.
3. `bot.error` is **not** terminal. It reports a streaming-provider fault while the bot keeps running.
4. `bot.done` is the final webhook on every path, streaming-only and never-admitted bots included. `audio.processed` is never final. This monitor stops as soon as the bot is out of the meeting; `MAX_POLLS` caps a bot that is genuinely still in a call.

## Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MEETSTREAM_API_KEY` | yes | | Not needed for `--explain` |
| `BOT_ID` | no | | The bot to watch |
| `MEETING_LINK` | no | | Used only when no bot id is given |
| `BOT_NAME` | no | `Status Monitor Bot` | Applies when creating a bot |
| `POLL_INTERVAL_MS` | no | `3000` | Milliseconds between status polls |
| `MAX_POLLS` | no | `400` | Poll budget, then the monitor stops |
| `MEETSTREAM_API_BASE_URL` | no | production | Override for testing |

## Troubleshooting

**`API error 404` on status** - the bot id is wrong, or the bot's data was deleted with `DELETE /bots/{id}/delete`.

**Detail section never appears** - `detail` returns 404 for a moment right after creation. It is optional decoration here, so failures are swallowed and the monitor keeps polling.

**Status shows `Unknown`** - the status payload came back in an unexpected shape. Run with `--raw` and check what the endpoint returned.

**It never stops** - the bot is genuinely still in the meeting. Use `GET /bots/{id}/remove_bot` to make it leave (see the `list-and-manage-bots` template).
