# Interactive Meeting Agent

A two-way meeting bot: it hears the room over `live_audio_required`, decides what to do, and responds over the `socket_connection_url` control channel. The decision function is a clearly-marked stub: everything around it is real API plumbing.

```bash
npm install
cp .env.example .env    # add MEETSTREAM_API_KEY, MEETING_LINK, NGROK_AUTHTOKEN
node index.js
```

Then say **"hey bot, what did I miss"** in the meeting.

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

1. `npm install`
2. `cp .env.example .env`
3. Fill in `MEETSTREAM_API_KEY`, `MEETING_LINK`, and either `PUBLIC_URL` or `NGROK_AUTHTOKEN`.
4. `node index.js` and admit the bot.
5. Say the wake word. The stub brain answers in chat.

**To have the bot reply with speech**, give it a real audio file:

```bash
ffmpeg -i reply.mp3 -f s16le -acodec pcm_s16le -ar 48000 -ac 1 reply.pcm
echo 'RESPONSE_AUDIO_FILE=./reply.pcm' >> .env
```

The file is validated at startup, before any bot is created, so a wrong sample rate fails immediately rather than playing back as chipmunks mid-meeting.

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
- The lifecycle ends at `audio.processed`. **`bot.done` never fires.** Do not wait on it.
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

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | From the MeetStream dashboard |
| `MEETING_LINK` | yes | Meeting for the bot to join |
| `PUBLIC_URL` | one of these two | An https:// address already pointing at this process |
| `NGROK_AUTHTOKEN` | one of these two | Opens a tunnel automatically |
| `WAKE_WORD` | no | Default `hey bot` |
| `RESPONSE_AUDIO_FILE` | no | PCM16/48k/mono file played as a spoken reply |
| `BARGE_IN` | no | `false` disables interrupt-on-human-speech |
| `RMS_THRESHOLD` | no | Speech energy threshold, default `500` |
| `SILENCE_MS` | no | Gap that ends a turn, default `900` |
| `PORT` | no | Local port, default `3000` |
| `BOT_NAME` | no | Name shown in the participant list |

## Troubleshooting

| Problem | Fix |
|---|---|
| Bot joins but nothing is heard | Check the `/audio` socket connected. `live_audio_required.websocket_url` must be `wss://`. |
| Audio arrives, no transcripts | The provider must be a `*_streaming` one. A post-call provider does not feed the live webhook. |
| Wake word never matches | The transcript is lowercased before matching, but check the log line for what was actually heard. Set a simpler `WAKE_WORD`. |
| Replies never appear | The control channel has not handshaked. `GET /health` shows `control_connected`. |
| Spoken reply sounds fast or slow | The file is not 48 kHz mono. Re-encode with the ffmpeg command above. |
| Bot talks over people | `BARGE_IN=true`, and remember `interrupt` only clears the queue on Google Meet |
| Bot reacts to half-sentences | Something is acting on interim segments. The brain should only handle `is_final: true`. |
| Waiting forever for `bot.done` | Streaming-only providers never emit it. The terminal event is `audio.processed`. |
| Bot left behind in the meeting | `GET /bots/{bot_id}/remove_bot` (it really is a GET) |

## Related

- [`websocket-bot-control`](../websocket-bot-control): the control channel on its own, with an interactive prompt
- [`realtime-audio-streaming`](../realtime-audio-streaming): live audio in, without the response path

## Resources

- [Meeting control and command patterns](https://docs.meetstream.ai/guides/web-sockets/meeting-control-and-command-patterns)
- [Create Bot endpoint](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [MeetStream docs](https://docs.meetstream.ai)
