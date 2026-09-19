# Stream Real-Time Meeting Audio over WebSocket with the MeetStream API

Send a MeetStream meeting bot into a Zoom, Google Meet or Microsoft Teams call and receive the live audio as raw PCM frames over a WebSocket, live transcript segments over a webhook, and bot lifecycle events, all in one `npm start`. The audio is re-broadcast on a local `/stream` endpoint so any speech-to-text or analytics app can consume it through a small provider plugin.

> Clone, fill in three env vars, `npm start`. No dashboard setup, no OAuth, no port-forwarding configuration.

## How it works

A single `node index.js` command:

1. Starts a local Express server (webhook receiver + WebSocket audio sink) on `PORT`.
2. Opens a public ngrok HTTPS tunnel automatically.
3. Calls `POST /bots/create_bot` with `callback_url`, `live_transcription_required.webhook_url` and `live_audio_required.websocket_url` pointing at the tunnel.
4. Streams everything live to your terminal: bot lifecycle events (with the stop reason from `bot_event`), live transcript segments with speaker names and confidence, per-speaker audio frames with RMS energy bars, participant join/leave events.
5. Archives per-speaker audio to `./logs/audio/<speaker>_<timestamp>.wav` (PCM16 LE, 48 kHz, mono).
6. Re-broadcasts every frame on `ws://localhost:3000/stream` for `bridge.js` or your own consumer.
7. Removes the bot with `GET /bots/{bot_id}/remove_bot` on Ctrl+C, and also on uncaught errors so no orphaned bot stays in the meeting.

## Architecture

```
Your terminal
|
+- Express server (localhost:3000)
|   +- POST /webhook/callback    <- bot lifecycle + participant events
|   +- POST /webhook/transcript  <- live transcript segments (per utterance)
|   +- WS   /audio               <- raw PCM frames from MeetStream (16-bit, 48 kHz, mono)
|   +- WS   /stream              -> the same frames, for bridge.js / your app
|
+- ngrok tunnel (auto-created)
    +- https://xxxx.ngrok.io -> localhost:3000
```

```
MeetStream Cloud
  +----------------------------------------------+
  |  Bot joins your meeting                       |
  |                                              |
  |  Audio capture  -> WebSocket -> /audio       |
  |  Live captions  -> Webhook   -> /transcript  |
  |  Lifecycle      -> Webhook   -> /callback    |
  +----------------------------------------------+
```

## Prerequisites

- Node.js 18 or newer (`node --version`)
- A MeetStream API key from <https://app.meetstream.ai>
- A free ngrok account and [authtoken](https://dashboard.ngrok.com/get-started/your-authtoken)
- A live meeting link (Google Meet, Zoom or Microsoft Teams)

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/realtime-audio-streaming
npm install
cp .env.example .env   # then fill in MEETSTREAM_API_KEY, NGROK_AUTHTOKEN, MEETING_LINK
node index.js          # or: npm start
```

That's it. Watch the terminal.

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>` |
| `NGROK_AUTHTOKEN` | yes | Opens the public tunnel for webhooks and the audio WebSocket |
| `MEETING_LINK` | yes | Google Meet, Zoom or Teams URL |
| `PORT` | no | Local server port (default `3000`) |
| `MAX_STREAM_CLIENTS` | no | Max simultaneous `/stream` consumers (default `10`) |
| `JOIN_TIMEOUT_MINUTES` | no | Give up, remove the bot and exit if no `bot.inmeeting` (or `bot.stopped`) arrives in this many minutes (default `12`) |
| `STREAM_URL` | no | Where `bridge.js` and `consumer-example.js` read audio from (default `ws://localhost:3000/stream`) |
| `STT_PROVIDER` | no | Provider `bridge.js` forwards to: `console` (default), `deepgram`, `assemblyai`, `openai-whisper` |
| `DEEPGRAM_API_KEY` | if `STT_PROVIDER=deepgram` | Deepgram key |
| `ASSEMBLYAI_API_KEY` | if `STT_PROVIDER=assemblyai` | AssemblyAI key |
| `OPENAI_API_KEY` | if `STT_PROVIDER=openai-whisper` | OpenAI key |

## Terminal output

```
10:42:01 i  Local server listening on port 3000
10:42:02 i  Opening ngrok tunnel...
10:42:04 i  ngrok tunnel: https://a1b2-203-0-113-0.ngrok.io
10:42:04 i  Creating MeetStream bot...
10:42:05 ok Bot created! ID: 5b0ff6e7-3cea-4c9f-a6b4-851c5f11cf4f
10:42:05 i  Waiting for bot to join the meeting...

10:42:18    bot.joining                     Bot is joining the meeting
10:42:31    bot.inmeeting                   Successfully joined the meeting

  Bot is LIVE in the meeting! Audio streaming now.

10:42:33 ~  Amy Stace           [####....] speaking   142.3 KB total
10:42:33 >  Amy Stace           I've reviewed the latest designs... [conf: 0.94]
10:42:35 ~  Theo Flynn          [........] silence    144.1 KB total
10:42:39    participant_events.join          Amy Stace joined
```

## Audio files

Per-speaker WAV files land in `./logs/audio/` (PCM16 LE, 48 kHz, mono):

```
logs/audio/
  Amy_Stace_1718123456789.wav
  Theo_Flynn_1718123456790.wav
```

They play in any audio player. To convert or resample with `ffmpeg`:

```bash
ffmpeg -i logs/audio/Amy_Stace_1718123456789.wav -ar 16000 amy-16k.wav
```

## API flow (what the code does)

### 1. Bot creation request

```json
POST https://api.meetstream.ai/api/v1/bots/create_bot
Authorization: Token YOUR_API_KEY

{
  "meeting_link": "https://meet.google.com/xxx-xxxx-xxx",
  "bot_name": "MeetStream Labs Bot",
  "video_required": false,
  "callback_url": "https://xxxx.ngrok.io/webhook/callback",
  "live_transcription_required": {
    "webhook_url": "https://xxxx.ngrok.io/webhook/transcript"
  },
  "live_audio_required": {
    "websocket_url": "wss://xxxx.ngrok.io/audio"
  },
  "recording_config": {
    "transcript": { "provider": { "meeting_captions": {} } },
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

`meeting_captions` is a streaming-only transcription provider, so this bot never receives `transcription.processed` and has no post-call transcript. The session still ends with `bot.done`, the final event on every path.

### 2. Webhook events you receive

**Bot lifecycle** (`POST /webhook/callback`). Every delivery carries `event`; most also carry `bot_event` (equal to `event` except on terminals) and an ISO `timestamp`:

```json
{ "bot_id": "...", "event": "bot.inmeeting", "bot_event": "bot.inmeeting", "bot_status": "InMeeting", "status_code": 200, "timestamp": "2026-01-15T14:30:00Z" }
```

Every ending arrives once as `event: "bot.stopped"` and `bot_event` gives the reason: `bot.stopped` (clean exit, 200), `bot.kicked` (a participant removed the bot, 200), `bot.notallowed` (waiting-room timeout, 500), `bot.denied` (500), `bot.failed` (usually 500). The logger prints `bot_event` and falls back to a case-insensitive `bot_status` only when it is missing. `bot.error` is not terminal (a streaming-provider hiccup; the bot keeps running). Deliveries are not retried, so acknowledge fast.

**Live transcript** (`POST /webhook/transcript`):

```json
{
  "speakerName": "Amy Stace",
  "timestamp": "2026-01-15T14:30:00.000Z",
  "transcript": "I've reviewed the latest designs.",
  "words": [
    { "word": "I've", "start": 0.0, "end": 0.4, "confidence": 0.95, "punctuated_word": "I've" }
  ]
}
```

### 3. Audio WebSocket

MeetStream connects to `wss://xxxx.ngrok.io/audio` and sends:

- Binary frames: `1 byte name_length | name | PCM16 LE audio, 48 kHz, mono` (see `src/audio.js`)
- Text frames: JSON speaker metadata `{ "speaker": "Amy Stace" }`

## Project structure

```
realtime-audio-streaming/
+- index.js               # Entry point: server + ngrok + bot orchestration
+- bridge.js              # Forwards /stream to whichever provider is configured
+- consumer-example.js    # Minimal example of reading /stream directly
+- src/
|   +- meetstream.js      # MeetStream REST API client (Token auth, retry on 429/5xx)
|   +- audio.js           # Binary PCM frame handler + per-speaker .wav writer
|   +- broadcaster.js     # Re-broadcasts live frames to /stream consumers
|   +- logger.js          # Pretty terminal output
|   +- providers/
|       +- provider-interface.js  # The contract every provider implements
|       +- deepgram.js             # Built-in: Deepgram speech-to-text
|       +- assemblyai.js           # Built-in: AssemblyAI speech-to-text
|       +- openai-whisper.js       # Built-in: OpenAI realtime transcription
|       +- console.js              # Built-in: no-network debug provider
|       +- reconnect-helper.js     # Reconnect with backoff (used by Deepgram)
+- logs/audio/            # Per-speaker .wav archive (git-ignored)
+- .env.example
+- package.json
```

## Supported platforms

| Platform | Notes |
|---|---|
| Google Meet | A meeting URL is enough |
| Zoom | Needs a Zoom app on your account; see the [Zoom platform guide](https://docs.meetstream.ai/guides/platforms/zoom) |
| Microsoft Teams | A meeting URL is enough; see the [Teams platform guide](https://docs.meetstream.ai/guides/platforms/microsoft-teams) |

## Connecting any external application

Real-time audio is streamed to external applications through `/stream`. Rather than hardcoding one app, this project uses a provider plugin system so you can point the live feed at whatever service you want without touching the core pipeline.

```
MeetStream bot -> your server -> /stream -> bridge.js -> [any provider] -> results
```

`bridge.js` never imports a specific app directly. It reads `STT_PROVIDER` from `.env`, dynamically loads the matching file from `src/providers/`, and forwards every audio frame to it through one fixed interface.

### Built-in providers

| Provider | `.env` value | Needs |
|---|---|---|
| Console (debug, no network) | `console` | nothing, works immediately |
| Deepgram | `deepgram` | `DEEPGRAM_API_KEY` ([sign up](https://console.deepgram.com/signup)) |
| AssemblyAI | `assemblyai` | `ASSEMBLYAI_API_KEY` ([sign up](https://www.assemblyai.com/dashboard/signup)) |
| OpenAI realtime transcription | `openai-whisper` | `OPENAI_API_KEY` ([platform.openai.com](https://platform.openai.com/api-keys)) |

### Switching providers

```bash
# In .env
STT_PROVIDER=deepgram
DEEPGRAM_API_KEY=your_key_here
```

```bash
npm start            # Terminal 1: joins the meeting, opens /stream
npm run bridge       # Terminal 2: forwards /stream to STT_PROVIDER
```

That is the entire change required to switch from one external app to another.

### Adding a new provider

1. Create `src/providers/your-app-name.js` exporting an object with three methods; see `src/providers/provider-interface.js` for the exact contract and a worked example.
2. Set `STT_PROVIDER=your-app-name` in `.env`.
3. `npm run bridge`

```js
export default {
  name: "My Custom App",

  // Called once on startup. Open your connection here.
  // Call onResult(text, isFinal) whenever you have something to show.
  async connect(onResult) { /* ... */ },

  // Called for every audio frame. pcm = raw PCM16 LE, 48 kHz, mono.
  sendAudio(pcm, speakerName) { /* ... */ },

  // Called once on shutdown. Clean up here.
  async disconnect() { /* ... */ },
};
```

Anything that can accept a stream of raw audio bytes and optionally talk back, whether a transcription API, a sentiment model, a keyword spotter or a custom WebSocket server, can be dropped in as a provider with no changes to `index.js`, `audio.js` or `broadcaster.js`.

### Verifying it works

Speak in the meeting. With `STT_PROVIDER=console` you will see byte counters proving frames are flowing. With `deepgram` or `assemblyai` you will see live transcripts, independent confirmation that the format, timing and `/stream` broadcast are all correct.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing required env var: ...` | `.env` missing or incomplete | `cp .env.example .env` and fill in all three values |
| 401 / 403 from the API | 401 = no key sent, 403 = wrong key | Check `MEETSTREAM_API_KEY` for stray quotes; regenerate it if needed |
| 400 on `create_bot` | Bad `MEETING_LINK` or an unsupported option | Use the full meeting URL |
| `ngrok tunnel failed` | Wrong `NGROK_AUTHTOKEN`, or a free account already has a tunnel open | Fix the token; close the other tunnel |
| Bot stuck in the waiting room | Nobody admitted it; `waiting_room_timeout` is 600 s | Admit the bot; it ends as `bot.stopped` with `bot_event: bot.notallowed` otherwise |
| `Gave up waiting for the bot to join after N minutes` | No `bot.inmeeting` or `bot.stopped` reached the webhook within `JOIN_TIMEOUT_MINUTES` | Check the meeting link and that the ngrok URL is reachable; raise `JOIN_TIMEOUT_MINUTES` if the lobby wait is legitimately long |
| `bot.stopped` with `bot_event: bot.kicked` / `bot.denied` | A participant removed the bot, or the host refused | Rejoin with a new bot |
| No audio frames received | The WebSocket URL is not `wss://` or not publicly reachable | Check the tunnel; audio is always captured (there is no `audio_required` opt-in) |
| No transcript segments | `meeting_captions` depends on platform captions being available | Switch the provider to `deepgram: { model: "nova-3" }` in `src/meetstream.js` if you have a key |
| `bridge.js` cannot connect | `index.js` is not running, or `PORT` changed | Start `npm start` first; set `STREAM_URL` to match |
| Tunnel dropped mid-meeting | ngrok disconnected; the bot still points at the old URL | Restart: `callback_url` is fixed at create time, so a new bot is needed |

## Resilience: what is handled and what is not

| Concern | Status | Where |
|---|---|---|
| MeetStream API retry on 429/5xx | Yes: exponential backoff, respects `Retry-After`; 4xx fails fast with the API's `message` in the error | `src/meetstream.js` |
| Bot never joins | Yes: bounded by `JOIN_TIMEOUT_MINUTES` (default 12); prints why it gave up, removes the bot, exits 1 | `index.js` |
| Provider socket reconnect (Deepgram) | Yes: auto-reconnect with backoff, drops frames while down | `src/providers/reconnect-helper.js` |
| Provider socket reconnect (AssemblyAI, OpenAI) | Not yet wired; follow the Deepgram pattern | `src/providers/*.js` |
| Slow `/stream` consumer backpressure | Yes: disconnected if buffered output exceeds 2 MB | `src/broadcaster.js` |
| Max concurrent `/stream` consumers | Yes: capped via `MAX_STREAM_CLIENTS` (default 10) | `index.js` |
| Uncaught exception / unhandled rejection | Yes: removes the bot and closes the tunnel before exiting | `index.js` |
| Malformed webhook payloads | Yes: validated, logged and ignored | `index.js` |
| ngrok tunnel drop | Detected and logged, not auto-healed: recovery needs a new public URL and therefore a new bot | `index.js` |
| Webhook authenticity verification | Not implemented: anyone who finds your ngrok URL could POST fake events. See [webhook signature verification](https://docs.meetstream.ai/guides/webhooks/webhook-signature-verification) | - |
| Multiple bots per process | Single bot per process by design | - |

## Related

- [Real-time audio streaming](https://docs.meetstream.ai/guides/websockets/real-time-audio-streaming)
- [Bridge server architecture](https://docs.meetstream.ai/guides/websockets/bridge-server-architecture)
- [Live transcription](https://docs.meetstream.ai/guides/transcription-recordings/live-transcription)
- [Meeting captions provider](https://docs.meetstream.ai/guides/transcription-recordings/providers/meeting-captions)
- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Webhook signature verification](https://docs.meetstream.ai/guides/webhooks/webhook-signature-verification)
- [ngrok Node SDK](https://ngrok.com/docs/using-ngrok-with/node-js/)
- Related templates: [../realtime-transcription](../realtime-transcription), [../realtime-video-streaming](../realtime-video-streaming), [../websocket-bot-control](../websocket-bot-control)
