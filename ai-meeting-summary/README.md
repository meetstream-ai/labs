# AI Meeting Summary

Fetch MeetStream's native AI meeting summary for a bot and print it as readable text.

```bash
cp .env.example .env   # add your MEETSTREAM_API_KEY and a BOT_ID or MEETING_LINK
npm install
node index.js
```

## What it does

MeetStream generates a summary of the meeting server-side, exposed at
`GET /bots/{bot_id}/summary`. There is no transcript to download, no LLM to
call, and no prompt to maintain on your side - one authenticated GET returns
the finished summary.

This template runs in one of two modes, decided by your `.env`:

| You set | What happens |
| --- | --- |
| `BOT_ID` | Summarise a meeting a bot already recorded. Nothing is created. |
| `MEETING_LINK` | Create a bot, wait for the meeting to end, then summarise it. |

`BOT_ID` wins if both are set, so you can re-run the summary step as often as
you like without sending another bot into a call.

## Prerequisites

- Node.js 18 or newer (uses the built-in `fetch`)
- A MeetStream API key - <https://app.meetstream.ai>
- A bot that has finished a meeting, or a live meeting link to send one into

## When the summary becomes available

The summary is a post-call artifact. It cannot exist until the meeting is over
and the recording has been processed:

```
bot.joining → bot.inmeeting → bot.recording → bot.leaving → bot.stopped
   → manifest.completed → audio.processed → transcription.processed
   → video.processed → bot.done          ← summary is ready around here
```

Two things follow from that:

1. **`GET /bots/{id}/summary` answers HTTP 202 while the summary is still
   generating.** 202 is not an error, it means "poll again". This template
   polls every `SUMMARY_POLL_INTERVAL_MS` up to `SUMMARY_POLL_MAX_ATTEMPTS`
   times and then gives up with a clear message rather than looping forever.
2. **The bot needs a post-call transcript provider.** When this template
   creates a bot it configures `deepgram` (`nova-3`), a post-call provider.
   Streaming-only providers (`deepgram_streaming`, `assemblyai_streaming`,
   `meetstream_streaming`, `jigsawstack_streaming`, `meeting_captions`) end
   their lifecycle at `audio.processed`, never emit `bot.done`, and produce no
   post-call transcript - so there is nothing to summarise.

If your workspace does not have a summary workflow enabled, the endpoint still
responds; the template tells you the fields came back empty instead of
pretending it found a summary.

## How it works

```
index.js               entry point and error reporting
src/client.js          MeetStream HTTP client (Token auth, 202/507 handling, retries)
src/session.js         resolve BOT_ID, or create a bot and wait for it to finish
src/summary.js         GET /bots/{id}/summary with a capped 202 poll
src/render.js          pretty-printer for the response
```

Three details worth copying into your own integration:

- **Auth header is `Authorization: Token <key>`** - literally the word `Token`,
  not `Bearer`.
- **HTTP 507 means "idempotent replay"** and is a success, not a failure. If
  you send an `Idempotency-Key` on `create_bot` and retry, the second call
  returns 507 with the original result. `src/client.js` treats it as success.
- **HTTP 202 means "still processing"**, and every poll loop needs a cap.

### About the response shape

`GET /bots/{id}/summary` returns the same envelope as `GET /bots/{id}/detail`
(`{ "bot_details": { ... } }`), and the summary-bearing fields inside it depend
on the summary workflow configured for your workspace. Rather than hardcode
field names that might not match your account, `src/render.js` walks the
response generically: summary-shaped keys first, session metadata second,
bulky plumbing fields (the echoed request payload, the raw status timeline)
hidden unless you set `SHOW_ALL_FIELDS=true`.

The untouched JSON is always written to `output/summary-<bot_id>.json`, so
nothing is lost to the formatter.

## Output

Console:

```
AI Meeting Summary
==================

Summary
-------
...

Session Details
===============

Bot ID: 305e708e-d0b5-4081-b982-fb9af84a716b
Platform: gmeet
Duration: 1834
Status: Done
```

File: `output/summary-<bot_id>.json` - the raw API response.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `MEETSTREAM_API_KEY is not set` | `cp .env.example .env` and paste your key. |
| HTTP 401 | No key was sent. Check `.env` is being loaded from the directory you ran `node` in. |
| HTTP 403 | The key is wrong or inactive for this workspace. |
| HTTP 404 | Wrong bot id, or the meeting's data already expired via its retention window. |
| Still 202 after the poll cap | The summary is genuinely still generating. Re-run later with `BOT_ID` set, or raise `SUMMARY_POLL_MAX_ATTEMPTS`. |
| "every field was empty" | No summary workflow is enabled for the workspace, or the meeting produced no transcript (for example a streaming-only provider, or nobody spoke). |
| Bot status ends at `NotAllowed` | The bot timed out in the waiting room. Admit it faster, or raise `WAITING_ROOM_TIMEOUT`. |
| Bot status ends at `Denied` | The host denied the bot entry. |
| HTTP 400 on create | Most often `in_call_recording_timeout` below its 600 second minimum. |

## Resources

- [MeetStream docs](https://docs.meetstream.ai)
- [API reference](https://docs.meetstream.ai/api-reference)
