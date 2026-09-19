# webhook-handler-complete

The reference MeetStream webhook receiver: handles every documented event, dedupes redeliveries, and reads `status_code` the way the API actually uses it.

```bash
npm install && node index.js
```

Want to see all of it work right now, without a meeting?

```bash
node index.js --simulate
```

---

## What this does

Runs an Express server that accepts MeetStream webhook deliveries at `POST /webhook` and:

- handles all 14 documented events with a dedicated, commented handler each
- decodes all five `bot.stopped` reasons from `bot_event` (`bot.stopped`, `bot.kicked`, `bot.notallowed`, `bot.denied`, `bot.failed`)
- treats duplicate deliveries as no-ops (idempotency keyed on `bot_id` + `bot_event ?? event` + `timestamp`)
- treats `bot.done` as the single "finished" signal on every path, streaming-only bots included
- builds a per-bot state record you can inspect at `GET /bots/:botId`
- optionally creates a real bot pointed at your public URL (`--create-bot`)

## Prerequisites

- Node.js 18 or newer (`node --version`)
- A MeetStream API key, only for `--create-bot`: https://app.meetstream.ai
- A public HTTPS URL, only for `--create-bot`. See the `webhook-local-tunnel` template.

## Setup

```bash
cp .env.example .env
npm install
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

## Idempotency

MeetStream delivers at least once. A slow handler, a dropped ACK, or a network blip can produce the same event twice.

`src/dedupe.js` keys deliveries on `bot_id + (bot_event ?? event) + timestamp`. A redelivery repeats the same `timestamp`; a genuinely new event (a second `bot.error`, say) has its own:

```js
deliveryKey({ botId: 'abc', event: 'bot.recording', timestamp: '2026-06-18T17:02:11.514Z' })
// 'abc:bot.recording:2026-06-18T17:02:11.514Z'
```

If a body ever arrives without `timestamp`, the key falls back to `bot_id + name`, folding in a hash of `message` for `bot.error`.

Response rules the server follows:

| Situation | Response | Why |
| --- | --- | --- |
| First time seeing this delivery | `200` | processed |
| Duplicate delivery | `200` | already processed, do no work, do not ask for a retry |
| Malformed envelope | `400` | redelivering the same bad body will not help |
| Your handler threw | `500` + dedupe claim released | you genuinely want a redelivery |
| Unknown event name | `200` | a newly added event must not cause a retry storm |

The store here is an in-memory `Map` with a 24 hour TTL so the template runs with zero setup. In production move it to Redis (`SET key NX EX 86400`) or a unique index in your database so it survives restarts and works across instances.

**ACK fast.** Do the minimum needed to record the delivery, return 200, and push real work onto a queue. Long handlers cause redeliveries.

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

**No deliveries arriving at all.** `callback_url` must be a public HTTPS URL. MeetStream cannot reach `http://` or `localhost`. There is no global webhook setting; every bot needs its own `callback_url` on `create_bot`.

**404s in the log.** The path in your `callback_url` must match `WEBHOOK_PATH` exactly. The server logs every unrouted request with the path it does expect.

**Same event handled twice.** The in-memory dedupe store resets on restart. That is expected for a template. Move it to Redis or your database for production.

**Waiting forever for `transcription.processed`.** You are on a streaming-only provider; it never sends one. Wait for `bot.done` instead, which arrives on every path. Set `TRANSCRIPT_PROVIDER` correctly, or stamp `custom_attributes.streaming_only`.

**Kicks look like clean exits, or failures slip through.** You are reading `bot_status` on `bot.stopped`. Read `bot_event`.

**`create_bot` returns 400 about `in_call_recording_timeout`.** The minimum is 600 seconds. Anything lower is rejected.

## Resources

- MeetStream Docs: https://docs.meetstream.ai
- API Reference: https://docs.meetstream.ai/api-reference
