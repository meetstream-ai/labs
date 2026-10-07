# Build an Interactive Voice Agent for Meetings with the MeetStream API

A two-way meeting bot for Zoom, Google Meet and Microsoft Teams built on the MeetStream API: it hears the room over `live_audio_required`, reads live transcription from a webhook, decides what to do, and responds in chat or speech over the `socket_connection_url` control channel. The decision function is a clearly-marked stub; everything around it is real API plumbing.

## How it works

- `create_bot` is called with `live_audio_required` (PCM frames in), `live_transcription_required` (transcript segments in), `callback_url` (lifecycle events in) and `socket_connection_url` (commands out), all pointing at this process over a public HTTPS/WSS URL.
- `src/audio-in.js` does energy-based turn detection on the PCM frames; the live transcript webhook supplies the words.
- `src/brain.js` matches a wake word on `is_final` segments and returns actions; `index.js` executes them as `sendchat`, `sendmsg`, `sendaudio` or `interrupt` frames.
- Ctrl+C removes the bot with `GET /bots/{bot_id}/remove_bot`, closes the tunnel and exits.

Once it is running, say **"hey bot, what did I miss"** in the meeting.

## Prerequisites

- Node.js 18 or newer
- A MeetStream API key ([app.meetstream.ai](https://app.meetstream.ai))
- A public HTTPS endpoint: either your own (`PUBLIC_URL`) or a free ngrok authtoken (`NGROK_AUTHTOKEN`)
- A live meeting link
- Optional: `ffmpeg`, if you want the bot to reply with speech

## The loop

```
                  ┌──────────────────────── your process ────────────────────────┐
                  │                                                              │
  meeting audio ──┼──► WS /audio      binary PCM frames ──► turn detection ──┐    │
                  │                                                          │    │
  live transcript ┼──► POST /transcript   "hey bot, ..."  ─────────────────► brain │
                  │                                                          │    │
  bot lifecycle ──┼──► POST /webhook                                         │    │
                  │                                                          ▼    │
  bot speaks   ◄──┼──── WS /control    sendchat · sendaudio · interrupt ◄─ actions │
                  │                                                              │
                  └──────────────────────────────────────────────────────────────┘
```

Three inputs, one output:

| Channel | Field on `create_bot` | Carries |
|---|---|---|
| `WS /audio` | `live_audio_required` | Binary PCM16 frames per speaker. Tells you *when* somebody talks. |
| `POST /transcript` | `live_transcription_required` | Transcript segments. Tells you *what* they said. |
| `POST /webhook` | `callback_url` | Lifecycle events |
| `WS /control` | `socket_connection_url` | Commands out: `sendchat`, `sendmsg`, `sendaudio`, `interrupt` |

Both `websocket_url` fields point at **your** server. This is a bring-your-own bridge. It is not how MIA works. A MIA bot is created with `agent_config_id` alone and never with `socket_connection_url` or `live_audio_required`.

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/interactive-meeting-agent
npm install
cp .env.example .env    # add MEETSTREAM_API_KEY, MEETING_LINK, and PUBLIC_URL or NGROK_AUTHTOKEN
node index.js
```

Admit the bot when it appears in the lobby, then say the wake word. The stub brain answers in chat.

**To have the bot reply with speech**, give it a real audio file:

```bash
ffmpeg -i reply.mp3 -f s16le -acodec pcm_s16le -ar 48000 -ac 1 reply.pcm
echo 'RESPONSE_AUDIO_FILE=./reply.pcm' >> .env
```

The file is validated at startup, before any bot is created, so a wrong sample rate fails immediately rather than playing back as chipmunks mid-meeting.

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>`. Checked before anything else starts. |
| `MEETING_LINK` | yes | Zoom, Google Meet or Teams link for the bot to join. |
| `PUBLIC_URL` | one of these two | An `https://` address already pointing at this process. Nothing is started for you. |
| `NGROK_AUTHTOKEN` | one of these two | Opens an ngrok tunnel automatically (capped at 30 s to come up). Ignored when `PUBLIC_URL` is set. |
| `WAKE_WORD` | no | Phrase that triggers the brain. Default `hey bot`. |
| `RESPONSE_AUDIO_FILE` | no | PCM16/48k/mono `.pcm`, `.raw` or WAV file played as a spoken reply. Validated at startup. Unset means chat only. |
| `BARGE_IN` | no | `false` disables interrupt-on-human-speech. Default `true`. |
| `RMS_THRESHOLD` | no | Speech energy threshold for turn detection. Default `500`. |
| `SILENCE_MS` | no | Gap that ends a turn. Default `900`. |
| `PORT` | no | Local HTTP and WebSocket port. Default `3000`. |
| `BOT_NAME` | no | Name shown in the participant list. Default `MeetStream Labs Agent`. |
| `MEETSTREAM_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |
| `NO_COLOR` | no | Set to anything to disable ANSI colour in the log output. |
| `ANTHROPIC_API_KEY` | no | Not read by the stub. Only needed once you wire a model into `src/brain.js`. |

**Recording defaults.** This template records audio only. `video_required: false` is sent explicitly, because the REST API treats an omitted `video_required` as true, and audio only is faster to process and smaller to store. If you turn video on, also send `recording_config.video_layout: "speaker_view"` (the API default is `grid_view`, so speaker view has to be explicit); use `grid_view` only when you want the composited mosaic of everyone. Per-participant video (`video_separate_streams`) is never set here.

## What you should see

Startup, with ngrok (timestamps are local time; `<...>` values come from your run):

```text
──────────────────────────────────────────────
  MeetStream Labs: Interactive Meeting Agent
  live audio in, control channel out
──────────────────────────────────────────────

10:21:40 i  Local server on port 3000
10:21:41 i  Public URL (ngrok): https://<subdomain>.ngrok-free.app
10:21:41 ·  socket_connection_url = wss://<subdomain>.ngrok-free.app/control
10:21:41 ·  live_audio_required   = wss://<subdomain>.ngrok-free.app/audio
10:21:41 ·  live transcription    = https://<subdomain>.ngrok-free.app/transcript
10:21:41 i  Creating bot…
10:21:42 ok Bot created: <bot_id> (status: <status>)
10:21:42 i  Wake word: "hey bot": say it in the meeting to trigger the brain.
10:21:42 ·  The brain in src/brain.js is a stub. Plug your LLM in there.
10:21:42 ·  Press Ctrl+C to remove the bot and exit.
```

Then the lifecycle webhooks arrive one per line (label is the `event`, green for `status_code` 200), followed by the two sockets connecting once the bot is admitted:

```text
10:21:50 bot.joining
10:21:55 bot.in_waiting_room
10:22:10 bot.inmeeting
10:22:10 ok Live audio WebSocket connected
10:22:10 ·  Live audio handshake from bot <bot_id>
10:22:11 ok Control channel ready: bot <bot_id>
10:22:11 ok Agent is live: listening and able to respond.
10:22:12 bot.recording
```

Say the wake word and the transcript, the match and the reply follow:

```text
10:22:30 ·  [interim] Amy Stace: hey bot what did
10:22:31 ·  [final] Amy Stace: Hey bot, what did I miss?
10:22:31 i  Wake word matched in: "Hey bot, what did I miss?"
10:22:32 ok sendchat → "Amy Stace, I heard: "what did I miss?". This template ships with a stub …"
10:22:33 ·  Amy Stace spoke for 2.1s
```

Ctrl+C removes the bot and exits 0:

```text
10:30:00 i  Shutting down (SIGINT)…
10:30:01 ok Bot <bot_id> removed from the meeting.
10:30:01 i  Control socket closed: code 1000
10:30:01 i  Live audio WebSocket closed (code 1000)
```

`GET http://localhost:3000/health` returns `{"ok":true,"bot_id":"<bot_id>","control_connected":true,"audio_bytes":<n>}`. If the bot ends on its own you see `bot.stopped` followed by `! Bot stopped. Reason: <bot_event> (bot_status: <bot_status>)`, then `bot.done` last.

## The brain is a stub. Everything else is not.

`src/brain.js` is the one placeholder in this template, and it says so at the top of the file. It matches a wake word and returns canned text. Replace it.

The contract is two async methods returning an array of actions:

```js
{ type: "chat", text }                 // sendchat, committed in one frame
{ type: "chat", text, stream: true }   // sendchat, streamed then committed
{ type: "msg",  text }                 // sendmsg
{ type: "say",  file }                 // sendaudio from a PCM16/48k/mono file
{ type: "interrupt" }                  // clear the bot's audio queue
```

Swapping in a model is a change to one function:

```js
import Anthropic from "@anthropic-ai/sdk";
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async onTranscript({ speaker, text, isFinal }) {
  if (!isFinal) return [];
  history.push({ role: "user", content: `${speaker}: ${text}` });

  const reply = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 300,
    system: "You are a meeting assistant. Answer in one or two sentences.",
    messages: history,
  });

  const answer = reply.content.find((b) => b.type === "text")?.text ?? "";
  history.push({ role: "assistant", content: answer });
  return answer ? [{ type: "chat", text: answer, stream: true }] : [];
}
```

For spoken answers, run the model output through TTS, write raw PCM16 LE / 48 kHz / mono, and return `{ type: "say", file }`. Chunking and pacing are already handled.

Keep responses short and the model call fast. Past roughly two seconds, the meeting has moved on by the time the bot speaks.

## What the plumbing already does for you

**Turn detection.** `src/audio-in.js` parses the binary frame envelope (`msg_type`, `speaker_id`, `speaker_name`, PCM payload), computes RMS per frame, and emits a turn when a speaker goes quiet for `SILENCE_MS`. Sub-300ms blips are discarded, and `"NoSpeaker"` frames (audio MeetStream could not attribute) never count as somebody taking a turn.

**Barge-in.** If a human starts talking while the bot is mid-sentence, `interrupt` fires and the local `sendaudio` loop is cancelled. Without cancelling locally you would clear the queue and then immediately refill it. Note that only Google Meet actually clears the queue; Zoom and Teams accept the command and ignore it.

**Audio pacing.** `sendaudio` chunks at 500ms and sends each chunk after `duration × 0.8`, keeping the bot's playback queue just ahead of the playhead: no gaps, no unbounded backlog.

**Interim versus final.** The brain only acts on `is_final: true` transcript segments. Interim segments are logged and ignored, otherwise the bot reacts to half-finished sentences.

**Every wait is capped.** The process itself runs until Ctrl+C, but nothing inside it waits forever: API calls retry at most 4 times on 429, 5xx or network errors and then fail with `Gave up after 5 attempts on <METHOD> <path>: <API message>`; the ngrok tunnel must come up within 30 s; and if the bot has not opened its control channel 660 s after `create_bot` (the 600 s `waiting_room_timeout` plus a minute), a warning tells you to check the webhook log and `GET /health` and to Ctrl+C. `sendaudio` and streamed chat loops are bounded by the data they send and stop on `interrupt`.

## Bot configuration

```json
{
  "meeting_link": "https://meet.google.com/xxx-xxxx-xxx",
  "bot_name": "MeetStream Labs Agent",
  "video_required": false,
  "callback_url": "https://<public>/webhook",
  "socket_connection_url": { "websocket_url": "wss://<public>/control" },
  "live_audio_required":   { "websocket_url": "wss://<public>/audio" },
  "live_transcription_required": { "webhook_url": "https://<public>/transcript" },
  "recording_config": {
    "transcript": { "provider": { "meetstream_streaming": {} } },
    "retention": { "type": "timed", "hours": 24 }
  },
  "automatic_leave": {
    "waiting_room_timeout": 600,
    "everyone_left_timeout": 60,
    "in_call_recording_timeout": 14400,
    "voice_inactivity_timeout": 900
  }
}
```

`live_transcription_required` requires a **streaming** provider. `meetstream_streaming` is built in and needs no extra key. Consequences worth knowing:

- Streaming-only providers produce **no post-call transcript**. `GET /transcript/{id}/get_transcript` returns `202` forever, so cap your retries.
- No `transcription.processed` / `transcription.failed` is ever sent. `audio.processed` is **not** final: `bot.done` still arrives last, as on every path, so use it as the "session finished" signal.
- `bot.error` is non-terminal: the streaming provider hiccuped, the bot keeps running.
- To get a transcript afterwards anyway, call `POST /bots/{bot_id}/transcribe` on the stored audio once the meeting ends.

## Wire formats

**Live audio binary frame** (`WS /audio`):

```
┌──────────┬────────────┬────────────┬──────────────┬──────────────┬─────────────────┐
│ msg_type │ sid_length │ speaker_id │ sname_length │ speaker_name │ pcm_audio_data  │
│ 1 byte   │ 2 bytes LE │ L1 bytes   │ 2 bytes LE   │ L2 bytes     │ remaining bytes │
└──────────┴────────────┴────────────┴──────────────┴──────────────┴─────────────────┘
```

`msg_type` is `0x01` for PCM. Payload is signed 16-bit PCM, little-endian, 48 kHz, mono, no container.

**Live transcript webhook** (`POST /transcript`): the text field is `transcript`, not `text`:

```json
{
  "bot_id": "305e708e-...",
  "speakerName": "Amy Stace",
  "timestamp": "2026-05-26T10:21:43.681Z",
  "transcript": "Hey bot, what did I miss?",
  "words": [{ "word": "Hey", "start": 26.1, "end": 26.4, "confidence": 0.9 }],
  "is_final": true
}
```

**Control commands** (`WS /control`): full reference in [`websocket-bot-control`](../websocket-bot-control).

## Project structure

```
interactive-meeting-agent/
├─ index.js                 # entry point: server, tunnel, bot, action executor
├─ src/
│   ├─ brain.js             # ⚠ STUB: plug your LLM in here
│   ├─ audio-in.js          # live_audio_required frame parser + turn detection
│   ├─ control-channel.js   # sendaudio / sendmsg / sendchat / interrupt / sendimg
│   ├─ pcm.js               # WAV/PCM loading and format validation
│   ├─ meetstream.js        # REST client (Token auth, retries, 507 handling)
│   ├─ tunnel.js            # PUBLIC_URL or ngrok
│   └─ logger.js            # zero-dependency terminal output
├─ .env.example
├─ package.json
└─ README.md
```

## Troubleshooting

API failures are printed as `x  MeetStream API <status> on <path>: <message>` (the API's own `message`) followed by a `·` hint line, and the process exits 1.

| Symptom | Cause | Fix |
|---|---|---|
| `Missing required env var: MEETSTREAM_API_KEY` (or `MEETING_LINK`) | `.env` is missing or the value is empty. Checked before the server starts. | `cp .env.example .env` and fill it in. |
| `No public URL available` | Neither `PUBLIC_URL` nor `NGROK_AUTHTOKEN` is set. | Set one of them. |
| `PUBLIC_URL must be an https:// URL` | Plain `http://` or `ws://` given. | MeetStream only dials TLS endpoints; use `https://`. |
| `Could not load @ngrok/ngrok` | Dependencies not installed. | `npm install`, or set `PUBLIC_URL` instead. |
| `ngrok did not open a tunnel within 30s` | No network, or a bad `NGROK_AUTHTOKEN`. | Fix the token or the connection, or set `PUBLIC_URL`. |
| `listen EADDRINUSE` | Another process owns `PORT`. | Stop it or set `PORT`. |
| `<file> is the wrong format: 44100 Hz, need 48000 Hz` / `is not a WAV file and does not have a .pcm/.raw extension` / `has an odd byte count` / `is empty` | `RESPONSE_AUDIO_FILE` is not PCM16 LE, 48 kHz, mono. Rejected at startup, before any bot exists. | Re-encode with the ffmpeg command above. |
| `MeetStream API 401 on /bots/create_bot` | No key was sent. | Check `.env` is loaded from this directory. |
| `MeetStream API 403 on /bots/create_bot` | The key was rejected. | Copy the complete key; regenerate it in the dashboard if needed. |
| `MeetStream API 400 on /bots/create_bot` | Invalid `meeting_link`, `in_call_recording_timeout` below 600, or a `websocket_url` that is not `wss://`. | Fix the value; the tunnel URL must be HTTPS. |
| `MeetStream API 404 on /bots/<id>/remove_bot` at shutdown | The bot had already left and been cleaned up. | Nothing to do. |
| `MeetStream API 409 on /bots/create_bot` | An equivalent request with the same `Idempotency-Key` is already in flight. | Re-run; every start uses a fresh key. |
| `POST /bots/create_bot → 429: retrying in 2.0s (attempt 1/4)` | Rate limited; the client honours `Retry-After`. | Wait; it retries 4 times then gives up. |
| `Gave up after 5 attempts on POST /bots/create_bot: ...` | 429, 5xx or a network error on every retry. The text after the colon is the API message. | Re-run; check connectivity if it persists. |
| `create_bot answered 200 without a bot_id` | Unexpected 2xx body. | Check the printed body; retry. |
| `No control-channel handshake 660s after create_bot` | The bot was never admitted, already stopped, or cannot reach your public URL. | Read the webhook lines above it (`bot.stopped` with `bot_event` `bot.notallowed` means lobby timeout), check `GET /health`, then Ctrl+C. |
| `Dropping N action(s): control channel is not connected` / `Control channel is not connected: the bot has not sent its ready handshake yet` | The brain answered before the bot's `ready` frame arrived, or after the socket closed. | Wait for `Control channel ready`; if it never comes, see the row above. |
| `Audio is already streaming. Use interrupt first.` | Two `say` actions overlapped. | Return one `say` per turn, or an `interrupt` first. |
| `A second bot connected to the control socket: closing the older one.` | Two bots were created against the same public URL. | Run one agent process per bot, or use separate `PORT`s and tunnels. |
| Bot joins but nothing is heard | The `/audio` socket never connected. | `live_audio_required.websocket_url` must be `wss://` and publicly reachable. |
| Audio arrives, no transcripts | The provider is not a `*_streaming` one; a post-call provider does not feed the live webhook. | Keep `meetstream_streaming` or another streaming provider. |
| Wake word never matches | The transcript is lowercased before matching, but the recogniser heard something else. | Check the log line for what was heard; set a simpler `WAKE_WORD`. |
| Replies never appear | The control channel has not handshaked. | `GET /health` shows `control_connected`; wait for the `ready` frame. |
| Spoken reply sounds fast or slow | The file is not 48 kHz mono PCM16. | Re-encode with the ffmpeg command above. |
| Bot talks over people | Barge-in is off, or the platform ignores `interrupt`. | Set `BARGE_IN=true`; only Google Meet clears the queue. |
| Bot reacts to half-sentences | Something is acting on interim segments. | The brain should only handle `is_final: true`. |
| Waiting forever for `transcription.processed` | Streaming-only providers never send it. | Wait for `bot.done` instead: it is the final event on every path, streaming-only included. |
| Bot stopped early with `bot_event` `bot.notallowed` or `bot.denied` | Never admitted from the lobby, or the host refused it. | Admit the bot; raise `waiting_room_timeout` if the host is slow. |
| Bot left behind in the meeting | The process exited without the shutdown hook. | `GET /bots/{bot_id}/remove_bot` (it really is a GET). |

## Related

- [Meeting control and command patterns](https://docs.meetstream.ai/guides/websockets/meeting-control-patterns)
- [Real-time audio streaming](https://docs.meetstream.ai/guides/websockets/real-time-audio-streaming)
- [Bridge server architecture](https://docs.meetstream.ai/guides/websockets/bridge-server-architecture)
- [Live transcription](https://docs.meetstream.ai/guides/transcription-recordings/live-transcription)
- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [Remove bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/remove-bot)
- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- Templates: [websocket-bot-control](../websocket-bot-control/README.md) is the control channel on its own, with an interactive prompt; [realtime-audio-streaming](../realtime-audio-streaming/README.md) is live audio in, without the response path.
