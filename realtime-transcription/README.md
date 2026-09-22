# Live Meeting Transcription over Webhook or WebSocket with MeetStream

Receive streaming transcription from a MeetStream meeting bot in a Zoom, Google Meet or Microsoft Teams meeting **while the meeting is still happening**, delivered either as HTTP webhook POSTs or over a persistent WebSocket. Uses the Deepgram or AssemblyAI streaming providers and commits a speaker turn each time `end_of_turn` arrives.

| Mode | Server | Bot command | Use when |
|---|---|---|---|
| **Webhook** (default) | `server.js` | `node index.js create-bot <url>` | Simple HTTP POST receiver |
| **WebSocket** | `ws-server.js` | `node index.js create-bot-ws <url>` | Persistent stream you can buffer and reprocess |

```bash
npm install
cp .env.example .env      # add MEETSTREAM_API_KEY and your public tunnel URL

npm start                                            # webhook receiver on :3000
node index.js create-bot https://meet.google.com/xxx-xxxx-xxx
```

Full walkthrough: **[how-to-run.md](./how-to-run.md)**

## What it does

1. `server.js` (or `ws-server.js`) receives live transcription events and keeps an in-memory session per `bot_id`.
2. `create-bot` sends `POST /bots/create_bot` with `live_transcription_required.webhook_url` (or `.websocket_url`) and a `*_streaming` provider under `recording_config.transcript.provider`.
3. Every chunk carries `speakerName`, `transcript`, `new_text`, `words[]`, `word_is_final` and `end_of_turn`. Interim words print as a live caption; `end_of_turn: true` commits the turn and calls `onTurnComplete()`, the hook to replace with your own logic.
4. `GET /sessions/:botId` returns the committed transcript for a session.

## Prerequisites

- Node.js 18+
- A MeetStream API key - [get one here](https://app.meetstream.ai/api-key)
- A public HTTPS (webhook) or WSS (WebSocket) URL to this machine: `ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000`. MeetStream must be able to reach your server.

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/realtime-transcription
npm install
cp .env.example .env      # MEETSTREAM_API_KEY, WEBHOOK_URL (base URL of the tunnel, no path)

npm start                 # terminal 1: webhook receiver
ngrok http 3000           # terminal 2: copy the https URL into WEBHOOK_URL
node index.js create-bot https://meet.google.com/xxx-xxxx-xxx   # terminal 3
```

WebSocket mode is the same with `npm run start:ws` (port 3001), `WEBSOCKET_URL=wss://...` and `node index.js create-bot-ws <url>`.

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `MEETSTREAM_API_KEY` | `create-bot*` | API key, sent as `Authorization: Token <key>`. The receivers do not need it. |
| `WEBHOOK_URL` | webhook mode | Public https base URL of the tunnel, no path. The script appends `/webhook`. |
| `WEBSOCKET_URL` | WebSocket mode | Public wss base URL of the tunnel, no path. The script appends `/ws`. |
| `PROVIDER` | no | `deepgram` (default) or `assemblyai`. Both are `*_streaming` providers. |
| `PORT` | no | Receiver port. Default `3000` (webhook) or `3001` (WebSocket). |

**Recording defaults.** This template records audio only, and now sends `video_required: false` explicitly: the REST API treats an omitted `video_required` as **true**, so leaving the field out silently records video. If you turn video on, also send `recording_config.video_layout: "speaker_view"`, because the API default is `grid_view`; use `grid_view` only when you want the mosaic of everyone. Per-participant video (`video_separate_streams`) is never set here.

## How it works

```
index.js          entry: loads .env, dispatches server | ws-server | create-bot | create-bot-ws
server.js         express: POST /webhook, GET /health, GET /sessions/:botId
ws-server.js      express + ws: WS /ws, GET /health, GET /sessions/:botId
create-bot.js     create_bot with live_transcription_required.webhook_url
create-bot-ws.js  create_bot with live_transcription_required.websocket_url
```

Good to know:

- `live_transcription_required` **requires** a streaming provider (`deepgram_streaming`, `assemblyai_streaming`, `jigsawstack_streaming`, `meetstream_streaming`). Pairing it with a post-call provider is an HTTP 400.
- Streaming-only bots deliver everything live and produce **no post-call transcript**: no `transcription.processed`, and a post-call `get_transcript` returns HTTP 202 indefinitely. `bot.done` still fires at the end. Treat the live stream as the record of truth, and persist committed turns yourself.
- Nothing in this template polls. The `create-bot*` scripts make one `create_bot` call and exit; the receivers are long-running servers that stay up until Ctrl+C and never wait for a bot state. If you add a wait loop of your own (for example polling `GET /bots/{bot_id}/status` until `InMeeting`, or `get_transcript` after a re-transcription), give it a maximum number of attempts and print why it gave up: against a streaming-only bot an uncapped `get_transcript` loop never ends.
- The receiver ACKs every POST with 200 before doing any work. MeetStream does not retry a delivery.
- `word_is_final: false` means the text may still change; `end_of_turn: true` is the signal to commit.
- The chunk payload and the committed-turn shape are documented in [how-to-run.md](./how-to-run.md#webhook-payload-reference).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Usage: MEETSTREAM_API_KEY=<key> WEBHOOK_URL=<url> node create-bot.js <meeting_url>` | A required value is missing. | Fill `.env` (loaded by `node index.js ...`) or export the variables, and pass the meeting URL. |
| `Failed to create bot` with HTTP 401 / 403 | No key was sent, or the key was rejected. | The header is `Authorization: Token <key>`; regenerate the key if 403 persists. |
| `Failed to create bot` with HTTP 400 | `live_transcription_required` paired with a post-call provider, or a bad `meeting_link`. | Keep `PROVIDER` at `deepgram` or `assemblyai` (both map to `*_streaming`). |
| Bot joins but nothing arrives | The tunnel is not reaching the receiver, or `WEBHOOK_URL` already ended in `/webhook` (the script appends it). | `curl https://<tunnel>/health`; set `WEBHOOK_URL` to the bare base URL. |
| `EADDRINUSE` on start | Another process owns the port. | Set `PORT`. |
| Captions print but no `✓` committed turns | The provider never sent `end_of_turn: true`. | For AssemblyAI check the turn-detection settings in `create-bot.js`; for Deepgram use `transcription_mode: "sentence"`. |
| `GET /sessions/:botId` returns 404 | No event for that `bot_id` reached this process. | Check the `bot_id` printed by `create-bot`. |
| Post-call `get_transcript` returns 202 forever | Expected: streaming-only bots have no post-call transcript. | Persist the live turns, or re-transcribe the audio with a post-call provider. |

## Related

- [Live transcription](https://docs.meetstream.ai/guides/transcription-recordings/live-transcription)
- [Deepgram streaming](https://docs.meetstream.ai/guides/transcription-recordings/providers/deepgram-streaming)
- [AssemblyAI streaming](https://docs.meetstream.ai/guides/transcription-recordings/providers/assemblyai-streaming)
- [Real-time audio streaming](https://docs.meetstream.ai/guides/websockets/real-time-audio-streaming)
- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- Sibling templates: [live-captions-overlay](../live-captions-overlay), [realtime-audio-streaming](../realtime-audio-streaming), [re-transcribe-audio](../re-transcribe-audio), [multi-provider-transcription](../multi-provider-transcription)
