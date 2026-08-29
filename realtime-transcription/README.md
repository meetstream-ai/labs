# Real-Time Transcription

Receive streaming transcription from a MeetStream bot **while the meeting is still happening** - over an HTTP webhook or a WebSocket.

Supports the **Deepgram** and **AssemblyAI** streaming providers.

| Mode | Server | Bot script | Use when |
|---|---|---|---|
| **Webhook** (default) | `server.js` | `create-bot.js` | Simple HTTP POST receiver |
| **WebSocket** | `ws-server.js` | `create-bot-ws.js` | Persistent stream you can buffer and reprocess |

## Quick start

```bash
npm install
cp .env.example .env      # add MEETSTREAM_API_KEY and your public tunnel URL

npm start                 # webhook mode  (then: node create-bot.js)
npm run start:ws          # websocket mode (then: node create-bot-ws.js)
```

Full walkthrough and troubleshooting: **[how-to-run.md](./how-to-run.md)**

## Prerequisites

- Node.js 18+
- A MeetStream API key - [get one here](https://app.meetstream.ai/api-key)
- A public HTTPS/WSS URL (ngrok or cloudflared) - MeetStream must be able to reach your server

## Good to know

- `live_transcription_required.webhook_url` **requires** a streaming provider
  (`deepgram_streaming`, `assemblyai_streaming`, `jigsawstack_streaming`, `meetstream_streaming`,
  or `meeting_captions`) - without one the API returns HTTP 400.
- Streaming-only bots deliver everything live and **end at `audio.processed`** - they never emit
  `bot.done`, and a post-call `get_transcript` will return HTTP 202 indefinitely. Treat the live
  stream as the record of truth.

## Docs

- [MeetStream Docs](https://docs.meetstream.ai) · [API Reference](https://docs.meetstream.ai/api-reference)
- [Live Transcription guide](https://docs.meetstream.ai/guides/transcription-recordings/live-transcription)
