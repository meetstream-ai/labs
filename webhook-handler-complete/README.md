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
- decodes all four `bot.stopped` reasons (`Stopped`, `NotAllowed`, `Denied`, `Error`)
- treats duplicate deliveries as no-ops (idempotency keyed on `bot_id` + `event`)
- knows that streaming-only bots END at `audio.processed` and never emit `bot.done`
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
  "bot_id": "0f1c...",
  "bot_status": "InMeeting",
  "message": "Bot is in the meeting",
  "status_code": 200,
  "custom_attributes": { "your": "strings" }
}
```

**The envelope key is `event`.** Any documentation that says `bot_event` is wrong. This template rejects an envelope that only carries `bot_event` rather than silently guessing, so a wrong integration fails loudly instead of quietly.

## The three rules people get wrong

### 1. `bot.stopped` is always `status_code: 200`

`bot.stopped` is the terminal event for the meeting phase. It carries 200 whether the call went perfectly or the host slammed the door. The reason lives in `bot_status`:

| `bot_status` | What happened | Media exists? |
| --- | --- | --- |
| `Stopped` | Clean exit. Processing events follow. | yes |
| `NotAllowed` | Nobody admitted the bot before `waiting_room_timeout`. | no |
| `Denied` | A host explicitly rejected the bot. | no |
| `Error` | The bot failed during the meeting. Read `message`. | maybe partial |

If you branch on `status_code` to decide success or failure, every failed run looks like a success. Branch on `bot_status`.

`status_code: 500` appears on exactly two events: `transcription.failed`, and a `bot.done` for a run that finished unsuccessfully.

### 2. Streaming-only providers never send `bot.done`

Where the event stream ends depends on the transcription provider you chose at `create_bot` time:

```
post-call provider (deepgram, assemblyai, sarvam, jigsawstack, meetstream)
  bot.joining -> bot.in_waiting_room -> bot.inmeeting -> bot.recording
  -> bot.leaving -> bot.stopped -> manifest.completed -> audio.processed
  -> transcription.processed | transcription.failed -> video.processed
  -> bot.done -> data_deletion

streaming-only provider (*_streaming, meeting_captions)
  bot.joining -> bot.inmeeting -> bot.recording -> bot.leaving
  -> bot.stopped -> manifest.completed -> audio.processed   [ENDS HERE]
```

Waiting for `bot.done` on a streaming-only bot means waiting forever.

The webhook payload does not tell you which provider was used, so this template stamps it into `custom_attributes.streaming_only` at `create_bot` time and reads it back off every delivery. Custom attribute values must be strings, so it is `"true"` / `"false"`, not booleans.

### 3. `bot.error` is not terminal

`bot.error` means a streaming provider hiccuped. The bot is still in the meeting and the lifecycle continues. Do not close out your bot record when you see one. It can also fire more than once, which is why the dedupe key for `bot.error` folds in a hash of `message` rather than collapsing every occurrence into one.

---

## Idempotency

MeetStream delivers at least once. A slow handler, a dropped ACK, or a network blip can produce the same event twice.

`src/dedupe.js` keys deliveries on `bot_id + event`:

```js
deliveryKey({ botId: 'abc', event: 'bot.recording' })   // 'abc:bot.recording'
deliveryKey({ botId: 'abc', event: 'bot.error', message: 'socket reset' })
// 'abc:bot.error:5c1f...' - repeatable events fold in the message
```

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
src/events.js         event catalog, bot.stopped reasons, status_code interpretation,
                      envelope parsing (rejects `bot_event`)
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

Segments carry `speaker` and `transcript`. The field is `transcript`, not `text`. An HTTP `202` means it is not ready yet, so poll with a cap. Streaming-only bots return `202` forever.

## Troubleshooting

**No deliveries arriving at all.** `callback_url` must be a public HTTPS URL. MeetStream cannot reach `http://` or `localhost`. There is no global webhook setting; every bot needs its own `callback_url` on `create_bot`.

**404s in the log.** The path in your `callback_url` must match `WEBHOOK_PATH` exactly. The server logs every unrouted request with the path it does expect.

**Same event handled twice.** The in-memory dedupe store resets on restart. That is expected for a template. Move it to Redis or your database for production.

**Waiting forever for `bot.done`.** You are on a streaming-only provider. Treat `audio.processed` as terminal. Set `TRANSCRIPT_PROVIDER` correctly, or stamp `custom_attributes.streaming_only`.

**Every run looks successful.** You are reading `status_code` on `bot.stopped`. Read `bot_status`.

**`create_bot` returns 400 about `in_call_recording_timeout`.** The minimum is 600 seconds. Anything lower is rejected.

## Resources

- MeetStream Docs: https://docs.meetstream.ai
- API Reference: https://docs.meetstream.ai/api-reference
