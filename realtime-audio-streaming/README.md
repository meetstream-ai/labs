# MeetStream Labs — Real-Time Audio Streaming

> **Zero-friction example.** Clone → fill in three env vars → `npm start`. No dashboard setup, no OAuth, no port-forwarding configuration.

---

## What this does

A single `node index.js` command:

1. Starts a local Express server (webhook receiver + WebSocket audio sink)
2. Opens a public **ngrok HTTPS tunnel** automatically — no server needed
3. Calls the **MeetStream API** to send a bot into your meeting
4. Streams everything live to your terminal:
   - 🤖 Bot lifecycle events (`joining → InMeeting → Stopped`)
   - 💬 Live transcript segments with speaker names & confidence scores
   - ♪ Per-speaker audio frames with RMS energy bars
   - 👤 Participant join/leave events
5. Saves raw PCM audio chunks to `./logs/audio/<speaker>.pcm`
6. Gracefully removes the bot on `Ctrl+C`

---

## Architecture

```
Your terminal
│
├─ Express server (localhost:3000)
│   ├─ POST /webhook/callback    ← bot lifecycle + participant events
│   ├─ POST /webhook/transcript  ← live transcript segments (per utterance)
│   └─ WS   /audio              ← raw PCM frames (16-bit, 16kHz, mono)
│
└─ ngrok tunnel (auto-created)
    └─ https://xxxx.ngrok.io  →  localhost:3000
         ↑
         MeetStream API sends all data here
```

```
MeetStream Cloud
  ┌──────────────────────────────────────────────┐
  │  Bot VM joins your meeting                    │
  │                                              │
  │  Audio capture ──► WebSocket ──► /audio      │
  │  Live ASR      ──► Webhook  ──► /transcript  │
  │  Lifecycle     ──► Webhook  ──► /callback    │
  └──────────────────────────────────────────────┘
```

---

## Quick start

### Prerequisites

- **Node.js 18+** (`node --version`)
- A **MeetStream API key** — [dashboard.meetstream.ai](https://dashboard.meetstream.ai)
- A **free ngrok account + authtoken** — [dashboard.ngrok.com](https://dashboard.ngrok.com/get-started/your-authtoken)
- A live meeting link (Google Meet, Zoom, or Teams)

### Steps

```bash
# 1. Clone
git clone https://github.com/meetstream-labs/audio-example
cd audio-example

# 2. Install
npm install

# 3. Configure
cp .env.example .env
# Open .env and fill in:
#   MEETSTREAM_API_KEY=...
#   NGROK_AUTHTOKEN=...
#   MEETING_LINK=https://meet.google.com/xxx-xxxx-xxx

# 4. Run
npm start
```

That's it. Watch the terminal.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `MEETSTREAM_API_KEY` | ✅ | From [MeetStream dashboard](https://dashboard.meetstream.ai) |
| `NGROK_AUTHTOKEN` | ✅ | From [ngrok dashboard](https://dashboard.ngrok.com/get-started/your-authtoken) |
| `MEETING_LINK` | ✅ | Google Meet, Zoom, or Teams URL |
| `PORT` | optional | Local server port (default `3000`) |

---

## Terminal output

```
╔══════════════════════════════════════════════════════╗
║         MeetStream Labs — Real-Time Audio            ║
╚══════════════════════════════════════════════════════╝

10:42:01 ℹ  Local server listening on port 3000
10:42:02 ℹ  Opening ngrok tunnel…
10:42:04 ℹ  ngrok tunnel: https://a1b2-203-0-113-0.ngrok.io
10:42:04 ℹ  Creating MeetStream bot…
10:42:05 ✔  Bot created! ID: 5b0ff6e7-3cea-4c9f-a6b4-851c5f11cf4f
10:42:05 ℹ  Waiting for bot to join the meeting…

10:42:18 ⏳  bot.joining                     Bot is joining the meeting
10:42:31 🤖  bot.inmeeting                   Successfully joined the meeting

  ✅  Bot is LIVE in the meeting! Audio streaming now.

10:42:33 ♪  Amy Stace           [████░░░░] ● speaking   142.3 KB total
10:42:33 💬 Amy Stace           I've reviewed the latest designs… [conf: 0.94]
10:42:35 ♪  Theo Flynn          [░░░░░░░░] ○ silence    144.1 KB total
10:42:39 💬 Theo Flynn          Thank you, we're excited to move… [conf: 0.91]
10:42:39 👤  participant_events.join          Amy Stace joined
```

---

## Audio files

Raw PCM files land in `./logs/audio/`:

```
logs/audio/
  Amy_Stace_1718123456789.pcm
  Theo_Flynn_1718123456790.pcm
```

**Convert to WAV** (requires `ffmpeg`):

```bash
ffmpeg -f s16le -ar 16000 -ac 1 -i logs/audio/Amy_Stace_*.pcm amy.wav
```

**Play directly**:

```bash
ffplay -f s16le -ar 16000 -ac 1 logs/audio/Amy_Stace_*.pcm
```

---

## API flow (what the code does)

### 1. Bot creation request

```json
POST https://api.meestream.ai/api/v1/bots/create_bot
Authorization: Token YOUR_API_KEY

{
  "meeting_link": "https://meet.google.com/xxx-xxxx-xxx",
  "audio_required": true,
  "video_required": false,
  "callback_url": "https://xxxx.ngrok.io/webhook/callback",
  "live_transcription_required": {
    "webhook_url": "https://xxxx.ngrok.io/webhook/transcript"
  },
  "live_audio_required": {
    "websocket_url": "wss://xxxx.ngrok.io/audio"
  },
  "recording_config": {
    "realtime_endpoints": [{
      "type": "webhook",
      "url": "https://xxxx.ngrok.io/webhook/callback",
      "events": ["participant_events.join", "participant_events.leave"]
    }],
    "retention": { "type": "timed", "hours": 24 }
  },
  "automatic_leave": {
    "waiting_room_timeout": 600,
    "everyone_left_timeout": 60,
    "in_call_recording_timeout": 14400
  }
}
```

### 2. Webhook events you receive

**Bot lifecycle** (`POST /webhook/callback`):
```json
{ "bot_id": "...", "event": "bot.inmeeting", "bot_status": "InMeeting", "status_code": 200 }
```

**Live transcript** (`POST /webhook/transcript`):
```json
{
  "speakerName": "Amy Stace",
  "timestamp": "2024-01-15T14:30:00.000Z",
  "transcript": "I've reviewed the latest designs.",
  "words": [
    { "word": "I've", "start": 0.0, "end": 0.4, "confidence": 0.95, "punctuated_word": "I've" }
  ]
}
```

### 3. Audio WebSocket

MeetStream connects to `wss://xxxx.ngrok.io/audio` and sends:
- **Binary frames**: raw PCM audio (16-bit LE, 16 kHz, mono)
- **Text frames**: JSON speaker metadata `{ "speaker": "Amy Stace" }`

---

## Project structure

```
meetstream-labs/
├─ index.js               # Entry point — server + ngrok + bot orchestration
├─ bridge.js               # Forwards /stream to whichever provider is configured
├─ consumer-example.js     # Minimal example of reading /stream directly
├─ src/
│   ├─ meetstream.js      # MeetStream REST API client
│   ├─ audio.js           # Binary PCM frame handler + per-speaker .wav writer
│   ├─ broadcaster.js     # Re-broadcasts live frames to /stream consumers
│   ├─ logger.js          # Pretty terminal output
│   └─ providers/
│       ├─ provider-interface.js  # The contract every provider implements
│       ├─ deepgram.js             # Built-in: Deepgram speech-to-text
│       ├─ assemblyai.js           # Built-in: AssemblyAI speech-to-text
│       └─ console.js              # Built-in: no-network debug provider
├─ logs/
│   └─ audio/             # Per-speaker .wav archive (git-ignored)
├─ .env.example           # Copy to .env and fill in
├─ package.json
└─ README.md
```

---

## Supported platforms

| Platform | Notes |
|---|---|
| Google Meet | No extra setup required — just a meeting URL |
| Zoom | Requires Zoom app setup (see [MeetStream Zoom guide](https://docs.meetstream.ai/guides/zoom/zoom-bot-guide)) |
| Microsoft Teams | Coming soon |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Missing required env var` | Copy `.env.example` → `.env` and fill in all three values |
| `ngrok tunnel failed` | Check `NGROK_AUTHTOKEN` is correct; free accounts allow 1 tunnel |
| `Bot stuck in waiting room` | The bot waits up to 10 minutes; admit it if your meeting has a lobby |
| `No audio frames received` | Ensure `audio_required: true` and the WS URL is `wss://` not `ws://` |
| `401 Unauthorized` | Regenerate your MeetStream API key from the dashboard |

---

## Connecting any external application

Real-time audio is streamed to external applications through `/stream` — but rather than hardcoding one app, this project uses a **provider plugin system**, so the company can point the live feed at whatever service it wants without touching the core pipeline.

```
MeetStream bot → your server → /stream → bridge.js → [any provider] → results
```

`bridge.js` never imports a specific app directly. It reads `STT_PROVIDER` from `.env`, dynamically loads the matching file from `src/providers/`, and forwards every audio frame to it through one fixed interface.

### Built-in providers

| Provider | `.env` value | Needs |
|---|---|---|
| Console (debug, no network) | `console` | nothing — works immediately |
| Deepgram | `deepgram` | `DEEPGRAM_API_KEY` ([free signup](https://console.deepgram.com/signup), $200 credit) |
| AssemblyAI | `assemblyai` | `ASSEMBLYAI_API_KEY` ([free signup](https://www.assemblyai.com/dashboard/signup)) |
| OpenAI GPT-Realtime-Whisper | `openai-whisper` | `OPENAI_API_KEY` ([platform.openai.com](https://platform.openai.com/api-keys)) |

### Switching providers

```bash
# In .env
STT_PROVIDER=deepgram
DEEPGRAM_API_KEY=your_key_here
```

```bash
# Terminal 1
npm start

# Terminal 2
npm run bridge
```

That's the entire change required to switch from one external app to another — no code edits.

### Adding a brand-new external application

The company isn't limited to the two built-in options. To wire up an in-house service, a different STT vendor, an analytics pipeline, or anything else:

1. Create `src/providers/your-app-name.js` exporting an object with three methods — see `src/providers/provider-interface.js` for the exact contract and a worked example
2. Set `STT_PROVIDER=your-app-name` in `.env`
3. `npm run bridge`

The contract is intentionally small:

```js
export default {
  name: "My Custom App",

  // Called once on startup. Open your connection here.
  // Call onResult(text, isFinal) whenever you have something to show.
  async connect(onResult) { /* ... */ },

  // Called for every audio frame. pcm = raw PCM16 LE, 48kHz, mono.
  sendAudio(pcm, speakerName) { /* ... */ },

  // Called once on shutdown. Clean up here.
  async disconnect() { /* ... */ },
};
```

Anything that can accept a stream of raw audio bytes and optionally talk back — a transcription API, a sentiment model, a keyword spotter, a custom WebSocket server — can be dropped in as a provider with no changes to `index.js`, `audio.js`, or `broadcaster.js`.

### Verifying it works

```bash
npm start            # Terminal 1 — joins the meeting, opens /stream
npm run bridge        # Terminal 2 — forwards /stream to STT_PROVIDER
```

Speak in the meeting. With `STT_PROVIDER=console` you'll see byte counters proving frames are flowing. With `deepgram` or `assemblyai` you'll see live transcripts — independent, third-party confirmation that the format, timing, and `/stream` broadcast are all correct.

```
🔌  MeetStream Labs — External Application Bridge

Provider     : deepgram

Connecting to Deepgram (speech-to-text)…
✔  Connected to Deepgram (speech-to-text)
Connecting to local stream: ws://localhost:3000/stream …
✔  Connected to your /stream endpoint
Waiting for meeting audio… speak in the meeting now.

… interim  hello can everyone
✔ FINAL  Hello, can everyone hear me okay? [0.97]
```

---



- [MeetStream API docs](https://docs.meetstream.ai)
- [Create Bot endpoint](https://docs.meetstream.ai/api-reference/endpoint/post-create-bot)
- [Callback events](https://docs.meetstream.ai/api-reference/callback-events)
- [Live transcripts](https://docs.meetstream.ai/api-reference/live-transcripts)
- [Socket connection](https://docs.meetstream.ai/api-reference/socket-connection)
- [ngrok Node SDK](https://ngrok.com/docs/using-ngrok-with/node-js/)

## Resilience — what's handled and what isn't

This started as an example project and has since had production-readiness gaps closed incrementally. Current state:

| Concern | Status | Where |
|---|---|---|
| MeetStream API retry on 429/5xx | ✅ Exponential backoff, respects `Retry-After` | `src/meetstream.js` |
| MeetStream API non-retryable errors fail fast | ✅ Bad auth/request errors don't waste time retrying | `src/meetstream.js` |
| Provider socket reconnect (Deepgram) | ✅ Auto-reconnect with backoff, drops frames (not buffers) while down | `src/providers/reconnect-helper.js` |
| Provider socket reconnect (AssemblyAI, OpenAI) | ⚠️ Not yet wired — follow the Deepgram pattern to add | `src/providers/*.js` |
| Slow `/stream` consumer backpressure | ✅ Disconnected if buffered output exceeds 2MB | `src/broadcaster.js` |
| Max concurrent `/stream` consumers | ✅ Capped via `MAX_STREAM_CLIENTS` (default 10) | `index.js` |
| Uncaught exception / unhandled rejection safety | ✅ Removes bot + closes tunnel before exiting, instead of leaving an orphaned bot in the meeting | `index.js` |
| Malformed webhook payload handling | ✅ Validated before use, logged and ignored rather than crashing | `index.js` |
| ngrok tunnel drop detection | ⚠️ Detected and logged loudly; **not auto-healed** — recovering requires a new public URL, which means re-creating the bot. Manual restart needed. | `index.js` |
| Webhook authenticity verification | ❌ Not implemented — anyone who discovers your ngrok URL could POST fake events. Low risk for short-lived demo tunnels, real risk for anything long-running or sensitive. | — |
| Horizontal scaling / multiple bots per process | ❌ Single bot per process by design — running multiple meetings means multiple process instances | — |

### Taking this further toward real production use

The two gaps most worth closing next, in order of impact:

1. **Webhook signature verification** — check whether MeetStream signs webhook payloads (HMAC header or similar) and verify it before trusting the body. Right now anyone who finds your ngrok URL can POST fabricated transcript/lifecycle events.
2. **ngrok auto-recovery** — on tunnel drop, the cleanest fix is: detect it (already done), then automatically `removeBot` + `createBot` again with a fresh tunnel URL, accepting the bot briefly leaves and rejoins the meeting. Not implemented here since it changes bot behavior mid-meeting in a way you may not want happening silently.
