# Build a Meeting Digest from a MeetStream Transcript

Send a meeting bot into Zoom, Google Meet or Microsoft Teams with the MeetStream API, wait for the call to end, then fetch the post-call transcript and print a local meeting digest: talk share per speaker and the opening lines.

MeetStream does not generate summaries server side (there is no `/bots/{bot_id}/summary` endpoint). Summaries come from your own LLM: hand it the transcript this template fetches. For a worked example with OpenAI or Anthropic, see [slack-meeting-summary](../slack-meeting-summary) or [notion-meeting-notes](../notion-meeting-notes).

## What it does

- Reads `BOT_ID` (digest a meeting that already happened) or `MEETING_LINK` (create a bot with a post-call transcription provider, wait for it to finish, then digest it).
- Polls `GET /bots/{bot_id}/status` until the bot reaches a terminal status, with a capped loop.
- Reads `bot_details.transcript_id` from `GET /bots/{bot_id}/detail`.
- Polls `GET /transcript/{transcript_id}/get_transcript`, treating HTTP 202 as "still processing" and stopping after `TRANSCRIPT_POLL_MAX_ATTEMPTS`.
- Computes the digest locally (no LLM, no extra API call), prints it, and writes it to `output/digest-<bot_id>.json`.

| You set | What happens |
| --- | --- |
| `BOT_ID` | Digest a meeting a bot already recorded. Nothing is created. |
| `MEETING_LINK` | Create a bot, wait for the meeting to end, then digest it. |

`BOT_ID` wins if both are set, so you can re-run the digest step as often as you like without sending another bot into a call.

## Prerequisites

- Node.js 18 or newer (uses the built-in `fetch`)
- A MeetStream API key from <https://app.meetstream.ai>
- A bot that has finished a meeting, or a live Zoom, Google Meet or Teams link to send one into

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/ai-meeting-summary
npm install
cp .env.example .env    # add MEETSTREAM_API_KEY and a BOT_ID or MEETING_LINK
node index.js
```

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>`. |
| `BOT_ID` | one of | Existing bot to digest. Takes priority over `MEETING_LINK`. |
| `MEETING_LINK` | one of | Zoom, Google Meet or Teams link. A new bot is created for it. |
| `BOT_NAME` | no | Display name in the meeting. Default `MeetStream Summary Bot`. |
| `TRANSCRIPT_LANGUAGE` | no | Language passed to the Deepgram post-call provider. Default `en`. |
| `RETENTION_HOURS` | no | `recording_config.retention.hours` on create. Default `72`. |
| `WAITING_ROOM_TIMEOUT` | no | `automatic_leave.waiting_room_timeout` seconds. Default `600`. |
| `EVERYONE_LEFT_TIMEOUT` | no | `automatic_leave.everyone_left_timeout` seconds. Default `600`. |
| `IN_CALL_RECORDING_TIMEOUT` | no | `automatic_leave.in_call_recording_timeout` seconds. Default `14400`, API minimum 600. |
| `IDEMPOTENCY_KEY` | no | `Idempotency-Key` header on `create_bot`. A replay returns HTTP 507 and is treated as success. |
| `STATUS_POLL_INTERVAL_MS` | no | Delay between status polls. Default `15000`. |
| `STATUS_POLL_MAX_ATTEMPTS` | no | Status poll cap. Default `240`. |
| `TRANSCRIPT_POLL_INTERVAL_MS` | no | Delay between transcript polls while the API answers 202. Default `10000`. The older `SUMMARY_POLL_INTERVAL_MS` still works. |
| `TRANSCRIPT_POLL_MAX_ATTEMPTS` | no | Transcript poll cap. Default `30`. The older `SUMMARY_POLL_MAX_ATTEMPTS` still works. |
| `DIGEST_OPENING_LINES` | no | How many opening transcript lines the digest shows. Default `10`. |
| `OUTPUT_DIR` | no | Where the digest JSON is written. Default `./output`. |
| `REQUEST_TIMEOUT_MS` | no | Per-request timeout. Default `30000`. |
| `MAX_RETRIES` | no | Retries on network errors and 429/5xx. Default `3`. |
| `RETRY_BASE_DELAY_MS` | no | Backoff base. Default `1000`. |
| `MEETSTREAM_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |

**Recording defaults.** This template records audio only: it sends `video_required: false` explicitly, because the REST API treats an omitted `video_required` as true. If you enable video, also send `recording_config.video_layout: "speaker_view"` (the API default is `grid_view`); use `grid_view` only when you want the composited mosaic of everyone. Per-participant video (`video_separate_streams`) is never enabled implicitly.

## When the transcript becomes available

The transcript is a post-call artifact. It cannot exist until the meeting is over and the recording has been processed:

```
bot.joining -> bot.inmeeting -> bot.recording -> bot.leaving -> bot.stopped
   -> audio.processed / manifest.completed -> transcription.processed   <- transcript is ready here
   -> bot.transcriptionready -> video.processed -> bot.done
```

Two things follow from that:

1. **`GET /transcript/{transcript_id}/get_transcript` answers HTTP 202 while the transcript is still processing.** 202 is not an error, it means "poll again". This template polls every `TRANSCRIPT_POLL_INTERVAL_MS` up to `TRANSCRIPT_POLL_MAX_ATTEMPTS` times and then gives up with a clear message rather than looping forever.
2. **The bot needs a post-call transcript provider.** When this template creates a bot it configures `deepgram` (`nova-3`), a post-call provider. Streaming-only providers (`deepgram_streaming`, `assemblyai_streaming`, `meetstream_streaming`, `jigsawstack_streaming`, `meeting_captions`) never emit `transcription.processed` and produce no post-call transcript, so `transcript_id` is empty and there is nothing to digest. They still end with `bot.done`, like every bot.

## How it works

```
index.js               entry point and error reporting
src/client.js          MeetStream HTTP client (Token auth, 202/507 handling, retries)
src/session.js         resolve BOT_ID, or create a bot and wait for it to finish
src/summary.js         transcript_id lookup, capped 202 poll on get_transcript, local digest
src/render.js          pretty-printer for the digest
```

Three details worth copying into your own integration:

- **Auth header is `Authorization: Token <key>`**, literally the word `Token`, not `Bearer`.
- **HTTP 507 means "idempotent replay"** and is a success, not a failure. If you send an `Idempotency-Key` on `create_bot` and retry, the second call returns 507 with the original result. `src/client.js` treats it as success.
- **HTTP 202 means "still processing"**, and every poll loop needs a cap.

### Adding a written summary

The digest is deterministic and free to compute. To add a prose summary, pass the segments from `fetchTranscript()` in `src/summary.js` to your own LLM (OpenAI, Anthropic or any other) and print its answer next to the digest. The LLM call, its cost and its prompt are yours; MeetStream supplies the transcript.

## Output

Console:

```
Meeting Digest
==============

3 speakers, 42 turns, 5120 words.

Talk Share (by words)
=====================

Speaker  Words  Turns  Share
-------  -----  -----  -----
Alice     2400     15  46.9%  █████████···········
...

Opening Lines
=============

Alice: Thanks for joining, everyone...
```

File: `output/digest-<bot_id>.json`, the digest (speaker stats and opening lines). The full transcript is not written to disk.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `MEETSTREAM_API_KEY is not set` | No `.env` or empty key. | `cp .env.example .env` and paste your key. |
| HTTP 401 | No key was sent. | Check `.env` is being loaded from the directory you ran `node` in. |
| HTTP 403 | The key is wrong or inactive for this workspace. | Generate a new key at <https://app.meetstream.ai>. |
| HTTP 404 | Wrong bot id, or the meeting's data already expired via its retention window. | Confirm the id with `GET /bots/{id}/detail`. |
| HTTP 400 on create | Most often `in_call_recording_timeout` below its 600 second minimum, or a missing `meeting_link` / `bot_name`. | Fix the value in `.env`. |
| Still 202 after the poll cap | The transcript is genuinely still processing. | Re-run later with `BOT_ID` set, or raise `TRANSCRIPT_POLL_MAX_ATTEMPTS`. |
| "has no transcript_id" | The bot used a streaming-only provider, or never recorded audio. | Use a post-call provider such as `deepgram`. |
| "The transcript came back empty" | Nobody spoke, or the provider produced no text. | Check the recording with `GET /bots/{id}/get_audio`. |
| Bot status ends at `NotAllowed` | The bot timed out in the waiting room. | Admit it faster, or raise `WAITING_ROOM_TIMEOUT`. |
| Bot status ends at `Denied` | The host denied the bot entry. | Ask the host to admit the bot next time. |
| HTTP 507 on create | Idempotent replay of an earlier `create_bot` with the same `Idempotency-Key`. | Nothing to fix; the original bot is returned. |

## Related

- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [Post-call transcription](https://docs.meetstream.ai/guides/transcription-recordings/post-call-transcription)
- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Error reference](https://docs.meetstream.ai/errors)
- [Transcript fetcher template](../transcript-fetcher/README.md)
