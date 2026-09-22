# Monitor MeetStream Bot Status as a Live Timeline

Poll `GET /bots/{id}/status` and `GET /bots/{id}/detail` with the MeetStream API and render the meeting bot lifecycle as a live timeline in your terminal, for Zoom, Google Meet and Microsoft Teams bots. Every `bot_status` value is explained, including the terminal ones and how they map to webhook events.

## How it works

- Takes a bot id from the command line, `BOT_ID`, or creates a bot from `MEETING_LINK` when neither is given.
- Polls `/status` every `POLL_INTERVAL_MS`, refreshes `/detail` on every state change and every 10th poll, and redraws the timeline in place (append-only log lines when stdout is not a TTY).
- Stops as soon as `bot_status` is terminal (`Stopped`, `NotAllowed`, `Denied`, `Error`/`FAILED`, `Done`), matched case-insensitively, or when `MAX_POLLS` is exhausted.
- `--explain` prints the full status reference with no API key needed.

## Prerequisites

- Node.js 18 or newer (built-in `fetch`)
- A MeetStream API key from <https://app.meetstream.ai>
- A bot id, or a Zoom, Google Meet or Teams `MEETING_LINK` so the template can create one for you

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/bot-status-monitor
npm install
cp .env.example .env   # then fill in MEETSTREAM_API_KEY
node index.js <bot_id>
```

## Usage

```bash
node index.js                  # monitors BOT_ID, or creates a bot from MEETING_LINK
node index.js bot_abc123       # monitors a specific bot
node index.js --explain        # prints the status reference and exits (no API key needed)
node index.js bot_abc123 --raw # dumps the raw detail payload when the session ends
```

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes (not for `--explain`) | API key, sent as `Authorization: Token <key>`. |
| `BOT_ID` | no | The bot to watch. A positional argument overrides it. |
| `MEETING_LINK` | no | Used only when no bot id is given: a bot is created for this link. |
| `BOT_NAME` | no | Display name when creating a bot. Default `Status Monitor Bot`. |
| `POLL_INTERVAL_MS` | no | Milliseconds between status polls. Default `3000`. |
| `MAX_POLLS` | no | Poll budget, then the monitor stops. Default `400` (about 20 minutes). |
| `MEETSTREAM_API_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |

**Recording defaults.** This template records audio only. `video_required: false` is sent explicitly, because the REST API treats an omitted `video_required` as true, and audio only is faster to process and smaller to store. If you turn video on, also send `recording_config.video_layout: "speaker_view"` (the API default is `grid_view`, so speaker view has to be explicit); use `grid_view` only when you want the composited mosaic of everyone. Per-participant video (`video_separate_streams`) is never set here.

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

1. Every webhook carries `event`, and most also carry `bot_event`. They differ only on terminals: every ending arrives as `event: "bot.stopped"` with the reason in `bot_event` (`bot.stopped`, `bot.kicked`, `bot.notallowed`, `bot.denied`, `bot.failed`). `bot_status` cannot tell a kick from a clean exit (both are `Stopped`), so use a webhook's `bot_event` when the exact reason matters, and fall back to a case-insensitive `bot_status` comparison only when `bot_event` is missing.
2. `bot.stopped` arrives with `status_code: 200` for a clean exit or a kick, and `500` for `NotAllowed`, `Denied` and most failures. Branch on `bot_event`, not the status code.
3. `bot.error` is **not** terminal. It reports a streaming-provider fault while the bot keeps running.
4. `bot.done` is the final webhook on every path, streaming-only and never-admitted bots included. `audio.processed` is never final. This monitor stops as soon as the bot is out of the meeting; `MAX_POLLS` caps a bot that is genuinely still in a call.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `MEETSTREAM_API_KEY is not set` | No `.env` or empty key. | `cp .env.example .env` and paste your key. `--explain` works without one. |
| `API error 401` / `403` | Key missing or rejected. | Check the key is complete and active for this workspace. |
| `API error 404` on status | Wrong bot id, or the bot's data was deleted with `DELETE /bots/{id}/delete` or expired via retention. | Confirm the id with `GET /bots`. |
| `API error 400` on create | Invalid `meeting_link`, or a missing `bot_name`. | Paste a full Zoom, Google Meet or Teams link into `MEETING_LINK`. |
| Detail section never appears | `/detail` returns 404 for a moment right after creation. | Nothing to do: it is optional decoration here, failures are swallowed and polling continues. |
| Status shows `Unknown` | The status payload came back in an unexpected shape. | Run with `--raw` and check what the endpoint returned. |
| It never stops | The bot is genuinely still in the meeting. | Call `GET /bots/{id}/remove_bot` to make it leave (see the list-and-manage-bots template), or lower `MAX_POLLS`. |
| `API error 429` | Rate limited by polling too fast. | Raise `POLL_INTERVAL_MS`. |

## Related

- [Get bot status](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-status)
- [Get bot details](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-details)
- [Remove bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/remove-bot)
- [How bots work](https://docs.meetstream.ai/guides/introduction/how-bots-work)
- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Debugging bots](https://docs.meetstream.ai/guides/help/debugging-bots)
- [Bot lifecycle state machine template](../bot-lifecycle-state-machine/README.md)
- [List and manage bots template](../list-and-manage-bots/README.md)
