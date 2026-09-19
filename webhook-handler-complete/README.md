# Complete MeetStream Webhook Handler for Meeting Bot Events

The reference MeetStream webhook receiver for Zoom, Google Meet and Microsoft Teams meeting bots: an Express server that handles every documented lifecycle, recording and transcription event, dedupes duplicate deliveries, decodes every `bot.stopped` reason from `bot_event`, and treats `bot.done` as the single finished signal.

## What it does

Runs an Express server that accepts MeetStream webhook deliveries at `POST /webhook` and:

- handles all 14 documented events with a dedicated, commented handler each
- decodes all five `bot.stopped` reasons from `bot_event` (`bot.stopped`, `bot.kicked`, `bot.notallowed`, `bot.denied`, `bot.failed`)
- treats duplicate deliveries as no-ops (idempotency keyed on `bot_id` + `bot_event ?? event` + `timestamp`)
- treats `bot.done` as the single "finished" signal on every path, streaming-only bots included
- builds a per-bot state record you can inspect at `GET /bots/:botId`
- replays every lifecycle path offline with `--simulate`, no API key or meeting needed
- optionally creates a real bot pointed at your public URL (`--create-bot`)

## Prerequisites

- Node.js 18 or newer (`node --version`)
- A MeetStream API key, only for `--create-bot`: <https://app.meetstream.ai>
- A public HTTPS URL, only for `--create-bot`. See the [webhook-local-tunnel](../webhook-local-tunnel/README.md) template.

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/webhook-handler-complete
npm install
cp .env.example .env
node index.js --simulate    # see every branch fire, no API calls
```

`--simulate` and the plain receiver need no API key.

## Run

```bash
# Receiver only. Point any bot's callback_url at it.
node index.js

# Replay every lifecycle path against the running receiver. No API calls.
node index.js --simulate

# Create a real bot whose callback_url is PUBLIC_URL + WEBHOOK_PATH.
node index.js --create-bot
```

Inspect state while it runs:

```bash
curl localhost:3000/health
curl localhost:3000/bots
curl localhost:3000/bots/sim-postcall-1
```

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `MEETSTREAM_API_KEY` | `--create-bot` only | API key, sent as `Authorization: Token <key>`. |
| `PORT` | no | Local port for the webhook server. Default `3000`. |
| `WEBHOOK_PATH` | no | Path the receiver listens on; `callback_url` must end with it. Default `/webhook`. |
| `PUBLIC_URL` | `--create-bot` only | Public https origin, no trailing slash. `callback_url` = `PUBLIC_URL` + `WEBHOOK_PATH`. |
| `MEETING_LINK` | `--create-bot` only | Zoom, Google Meet or Teams link the bot joins. |
| `BOT_NAME` | no | Display name in the meeting. Default `Webhook Reference Bot`. |
| `VIDEO_REQUIRED` | no | Record video as well as audio. Default `false`. |
| `TRANSCRIPT_PROVIDER` | no | Post-call or streaming provider; decides whether a post-call transcript exists. Default `deepgram`. |
| `MEETSTREAM_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |
| `NO_COLOR` | no | Set to anything to disable ANSI colour in the log output. |

---

## The envelope

MeetStream POSTs this JSON to your `callback_url`:

```json
{
  "event": "bot.inmeeting",
  "bot_event": "bot.inmeeting",
  "bot_id": "0f1c...",
  "bot_status": "InMeeting",
  "message": "Bot is in the meeting",
  "status_code": 200,
  "timestamp": "2026-06-18T17:02:11.514Z",
  "custom_attributes": { "your": "strings" }
}
```

`event` is always present and is the generic event name. `bot_event` is the specific name: it equals `event` on every event except terminals, and a few events (`manifest.completed`, `manifest.skipped`, `bot.transcriptionready`, `bot.uploading`, `participant_events.*`) do not carry it. Read `bot_event ?? event` when you need the specific name. Every delivery carries an ISO 8601 `timestamp`, lifecycle events included. `participant_events.*` use a nested shape with the bot id at `data.bot.id`; `data_deletion` has no `custom_attributes`.

## The three rules people get wrong

### 1. Every ending is `bot.stopped`; the reason is in `bot_event`

Every bot ends exactly once with `event: "bot.stopped"`. There is no delivery with `event: "bot.kicked"` or `"bot.notallowed"`; those names only appear in `bot_event`:

| `bot_event` | `status_code` | `bot_status` | What happened | Media exists? |
| --- | --- | --- | --- | --- |
| `bot.stopped` | 200 | `Stopped` | Clean exit: meeting ended, `remove_bot`, or a timeout. | yes |
| `bot.kicked` | 200 | `Stopped` | A participant removed the bot. | yes, up to the kick |
| `bot.notallowed` | 500 | `NotAllowed` | Nobody admitted the bot before `waiting_room_timeout`. | no |
| `bot.denied` | 500 | `Denied` | A host refused entry or recording. | no |
| `bot.failed` | usually 500 | `FAILED` / `ERROR` / `Failed` | The bot crashed. Read `message`. | maybe partial |

Branch on `bot_event`. Do not branch on `bot_status`: a kick and a clean exit both say `Stopped`, and the failure casing varies. `src/events.js` (`stopReason`) falls back to `bot_status`, compared case-insensitively, only when `bot_event` is missing. `status_code` is a coarse hint at best.

`status_code: 500` also appears on `transcription.failed`.

### 2. `bot.done` is the final event on every path

`audio.processed` is never final. Every bot, whatever the provider and whether or not it got in, ends with `bot.done`:

```
post-call provider (deepgram, assemblyai, sarvam, jigsawstack, meetstream)
  bot.joining -> bot.in_waiting_room -> bot.inmeeting -> bot.recording
  -> bot.leaving -> bot.stopped -> manifest.completed / audio.processed
  -> transcription.processed | transcription.failed -> bot.transcriptionready
  -> video.processed -> bot.done -> data_deletion (later)

streaming-only provider (*_streaming, meeting_captions)
  bot.joining -> bot.inmeeting -> bot.recording -> bot.leaving
  -> bot.stopped -> manifest.completed / audio.processed -> bot.done

never admitted
  bot.joining -> bot.in_waiting_room -> bot.leaving
  -> bot.stopped (bot_event bot.notallowed or bot.denied) -> bot.done
```

What differs for streaming-only providers is that no `transcription.processed` / `transcription.failed` ever arrives and no post-call transcript exists, so do not wait for or fetch one.

The webhook payload does not tell you which provider was used, so this template stamps it into `custom_attributes.streaming_only` at `create_bot` time and reads it back off every delivery. Custom attribute values must be strings, so it is `"true"` / `"false"`, not booleans.

### 3. `bot.error` is not terminal

`bot.error` means a streaming provider hiccuped. The bot is still in the meeting and the lifecycle continues. Do not close out your bot record when you see one. It can also fire more than once; each occurrence has its own `timestamp`, so the dedupe key keeps them apart.

---

## Delivery and idempotency

MeetStream sends each event once and **does not retry** a failed or timed-out delivery. Two consequences:

- **ACK fast.** Return 200 as soon as the delivery is recorded and push real work onto a queue. A handler that times out loses the event; there is no second attempt.
- **Duplicates still happen**, from your own infrastructure: a tunnel or proxy replay, a queue re-driving a job, or you replaying stored bodies. `src/dedupe.js` keys deliveries on `bot_id + (bot_event ?? event) + timestamp`, so a replayed body is a no-op while a genuinely new event (a second `bot.error`, say) has its own timestamp:

```js
deliveryKey({ botId: 'abc', event: 'bot.recording', timestamp: '2026-06-18T17:02:11.514Z' })
// 'abc:bot.recording:2026-06-18T17:02:11.514Z'
```

If a body ever arrives without `timestamp`, the key falls back to `bot_id + name`, folding in a hash of `message` for `bot.error`.

Response rules the server follows:

| Situation | Response | Why |
| --- | --- | --- |
| First time seeing this delivery | `200` | processed |
| Duplicate delivery | `200` | already processed, do no work |
| Malformed envelope | `400` | the payload itself is wrong; logged for inspection |
| Your handler threw | `500` + dedupe claim released + raw body logged | MeetStream will not resend, so the log line is what you replay from |
| Unknown event name | `200` | a newly added event is recorded, not dropped |

The store here is an in-memory `Map` with a 24 hour TTL so the template runs with zero setup. In production move it to Redis (`SET key NX EX 86400`) or a unique index in your database so it survives restarts and works across instances.

---

## How it works

```
index.js              CLI: receiver, --simulate, --create-bot
src/config.js         env loading, provider classification, fail-fast on bad config
src/events.js         event catalog, bot.stopped reasons (from bot_event), status_code
                      interpretation, envelope parsing
src/dedupe.js         DeliveryLog: claim-once with TTL
src/handlers.js       one handler per event + dispatch
src/server.js         Express app, idempotency gate, response-code policy
src/meetstream.js     create_bot / remove_bot / detail, `Token` auth, 507-as-success
src/simulate.js       synthetic envelopes for every lifecycle path
src/logger.js         timestamped console output
```

To use this in your own app, take `src/events.js`, `src/dedupe.js`, and `src/handlers.js`, and replace the log lines in each handler with your own work.

## Getting the transcript

`transcript_id` is **not** in any webhook. Get it from one of:

- the `create_bot` response (`{ bot_id, transcript_id, meeting_url, status }`)
- `GET /bots/{bot_id}/detail`
- `GET /bots/{bot_id}/transcriptions`

Then, after `transcription.processed`:

```
GET /transcript/{transcript_id}/get_transcript?raw=false
```

Segments carry `speaker` and `transcript`. The field is `transcript`, not `text`. An HTTP `202` means it is not ready yet, so poll with a cap. Streaming-only bots have no post-call transcript and return `202` forever, so do not fetch one for them.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Missing MEETSTREAM_API_KEY` | `--create-bot` needs a key; the receiver and `--simulate` do not. | `cp .env.example .env` and paste your key. |
| `PUBLIC_URL is required with --create-bot` | MeetStream must reach your webhook over HTTPS. | Use the webhook-local-tunnel template and set `PUBLIC_URL`. |
| No deliveries arriving at all | `callback_url` is not a public HTTPS URL, or the bot was created without one. | MeetStream cannot reach `http://` or `localhost`; every bot needs its own `callback_url` on `create_bot`. |
| 404s in the log | The path in `callback_url` does not match `WEBHOOK_PATH`. | The server logs every unrouted request with the path it expects. |
| An event is missing from the sequence | Your handler timed out or returned non-2xx; MeetStream does not retry. | ACK first, do the work after; check `GET /bots/{id}/detail` for the timeline. |
| Same event handled twice | The in-memory dedupe store resets on restart. | Move it to Redis or your database for production. |
| Waiting forever for `transcription.processed` | Streaming-only provider; it never sends one. | Wait for `bot.done` instead. Set `TRANSCRIPT_PROVIDER` correctly, or stamp `custom_attributes.streaming_only`. |
| Kicks look like clean exits, or failures slip through | You are reading `bot_status` on `bot.stopped`. | Read `bot_event`. |
| `create_bot` returns 400 about `in_call_recording_timeout` | The minimum is 600 seconds. | Raise the value. |
| `create_bot` returns 401 / 403 | No key sent, or the key was rejected. | Check `MEETSTREAM_API_KEY`. |
| `create_bot` returns 507 | Idempotent replay of an earlier request. | Nothing to fix; the original bot is returned. |

## Related

- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Local webhook server](https://docs.meetstream.ai/guides/webhooks/local-webhook-server)
- [Workspace webhooks](https://docs.meetstream.ai/guides/webhooks/workspace-webhooks)
- [Webhook signature verification](https://docs.meetstream.ai/guides/webhooks/webhook-signature-verification)
- [Custom attributes](https://docs.meetstream.ai/guides/features/custom-attributes)
- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [Error reference](https://docs.meetstream.ai/errors)
- Templates: [webhook-local-tunnel](../webhook-local-tunnel/README.md), [bot-lifecycle-state-machine](../bot-lifecycle-state-machine/README.md), [idempotency-and-dedup](../idempotency-and-dedup/README.md), [error-handling-and-retries](../error-handling-and-retries/README.md)
