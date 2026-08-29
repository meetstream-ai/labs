# WebSocket Bot Control

The bring-your-own bridge control channel. Run a WebSocket server, point a bot at it with `socket_connection_url`, and drive the bot live from an interactive prompt: play audio through its microphone, post chat, interrupt playback, change its camera feed.

```bash
npm install
cp .env.example .env    # add MEETSTREAM_API_KEY, MEETING_LINK, NGROK_AUTHTOKEN
node index.js
```

## Prerequisites

- Node.js 18 or newer
- A MeetStream API key ([app.meetstream.ai](https://app.meetstream.ai))
- A public HTTPS endpoint: either your own (`PUBLIC_URL`) or a free ngrok authtoken (`NGROK_AUTHTOKEN`)
- A live meeting link

## Setup

1. `npm install`
2. `cp .env.example .env`
3. Fill in `MEETSTREAM_API_KEY` and `MEETING_LINK`.
4. Set `PUBLIC_URL` or `NGROK_AUTHTOKEN`.
5. `node index.js`, admit the bot, then type commands at the `control>` prompt.

## How it works

```json
POST https://api.meetstream.ai/api/v1/bots/create_bot
Authorization: Token YOUR_API_KEY

{
  "meeting_link": "https://meet.google.com/xxx-xxxx-xxx",
  "bot_name": "MeetStream Labs Control Bot",
  "video_required": false,
  "callback_url": "https://<public>/webhook",
  "socket_connection_url": { "websocket_url": "wss://<public>/control" },
  "automatic_leave": {
    "waiting_room_timeout": 600,
    "everyone_left_timeout": 60,
    "in_call_recording_timeout": 14400
  }
}
```

The bot joins the meeting and then connects **outwards** to your WebSocket as a client. It announces itself with a handshake:

```json
{ "type": "ready", "bot_id": "bot_abc123", "message": "Ready to receive messages" }
```

From there the channel carries JSON commands from you to the bot. It closes with code `1000` when the bot leaves.

> `socket_connection_url` points at **your** server. It is a bridge you host. It is not a MeetStream-hosted endpoint, and it is not how MIA works: a MIA bot is created with `agent_config_id` alone and never with `socket_connection_url` or `live_audio_required`.

## The commands

Every command is a JSON object with a `command` field and the `bot_id` from the handshake.

### `sendaudio`: play audio through the bot's microphone

```json
{
  "command": "sendaudio",
  "bot_id": "bot_abc123",
  "audiochunk": "<base64 of raw PCM16 LE bytes>",
  "sample_rate": 48000,
  "encoding": "pcm16",
  "channels": 1,
  "endianness": "little"
}
```

Audio must be **raw PCM, signed 16-bit, little-endian, 48000 Hz, mono, base64-encoded, with no WAV header**. Nothing else is accepted, and nothing is resampled for you.

Send it in 0.5 to 2 second chunks and pace slightly faster than real time: this template sends each chunk after `duration × 0.8`, which keeps the bot's playback queue just ahead of the playhead so there are no gaps, without building a backlog that `interrupt` would then have to discard.

```bash
# any input -> the exact format sendaudio wants
ffmpeg -i greeting.mp3 -f s16le -acodec pcm_s16le -ar 48000 -ac 1 greeting.pcm
```

`src/pcm.js` reads `.wav` (walking the RIFF chunks, not assuming a 44-byte header) or headerless `.pcm`/`.raw`, and refuses anything at the wrong sample rate or channel count rather than playing it back as chipmunks.

### `sendmsg`: chat message

```json
{ "command": "sendmsg", "bot_id": "bot_abc123", "message": "Hello!", "msg": "Hello!" }
```

**`message` and `msg` must both be set to the same value.** Different meeting platforms read different keys; setting only one works on some platforms and silently does nothing on others.

### `sendchat`: chat message with role and streaming

```json
{ "command": "sendchat", "bot_id": "bot_abc123", "role": "assistant", "text": "Here is my response...", "is_final": true }
```

| Field | Type | Notes |
|---|---|---|
| `role` | string | `"assistant"` or `"user"` |
| `text` | string | The message |
| `is_final` | bool | `false` for interim tokens, `true` for the committed message |

To stream an LLM response as it generates, send `is_final: false` repeatedly with growing `text`, then one `is_final: true` frame with the final text. The `stream` REPL command does exactly this.

### `interrupt`: stop queued audio

```json
{ "command": "interrupt", "bot_id": "bot_abc123", "action": "clear_audio_queue" }
```

**Google Meet only fully clears the queue.** Zoom and Teams accept the command without clearing. Locally, `interrupt` also cancels the in-process `sendaudio` loop, otherwise it would immediately refill the queue it just cleared.

### `sendimg`: camera feed from base64

```json
{ "command": "sendimg", "bot_id": "bot_abc123", "img": "<base64 JPEG or PNG>" }
```

### `sendimg_url`: camera feed from a public URL

```json
{ "command": "sendimg_url", "bot_id": "bot_abc123", "img_url": "https://example.com/bot-avatar.png" }
```

The URL must be publicly reachable.

> `sendimg` and `sendimg_url` set the bot's **camera feed**. They are not the same as `POST /bots/{bot_id}/send_image`, which posts a picture into the meeting **chat**. See [`send-image-bot`](../send-image-bot) for that.

## The interactive prompt

```
control> msg Hello from the bridge
control> chat I can answer questions in this meeting
control> stream Thinking about that now...
control> audio ./greeting.pcm
control> interrupt
control> imgurl https://example.com/avatar.png
control> img ./logo.png
control> status
control> quit
```

`interrupt` typed while `audio` is still streaming is processed straight away, because the prompt does not block on the audio loop.

| Command | Sends |
|---|---|
| `msg <text>` | `sendmsg` |
| `chat <text>` | `sendchat` with `is_final: true` |
| `stream <text>` | `sendchat` interim frames, then a final one |
| `audio <path>` | `sendaudio`, chunked and paced |
| `interrupt` | `interrupt` with `clear_audio_queue` |
| `imgurl <url>` | `sendimg_url` |
| `img <path>` | `sendimg` (base64 of the local file) |
| `status` | nothing: prints local connection state |
| `quit` | removes the bot and exits |

## Local endpoints

| Endpoint | Direction | Purpose |
|---|---|---|
| `WS /control` | MeetStream to you | The control channel. This is the URL passed as `socket_connection_url.websocket_url`. |
| `POST /webhook` | MeetStream to you | Bot lifecycle events |
| `GET /health` | - | Bot id and whether the control channel is connected |

## Project structure

```
websocket-bot-control/
├─ index.js                 # entry point: server, tunnel, bot creation, REPL, shutdown
├─ src/
│   ├─ control-channel.js   # every command, plus audio chunking and pacing
│   ├─ pcm.js               # WAV/PCM loading and format validation
│   ├─ repl.js              # the interactive prompt
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
| `PORT` | no | Local port, default `3000` |
| `BOT_NAME` | no | Name shown in the participant list |
| `GREETING` | no | A `sendmsg` fired as soon as the channel is ready |

## Troubleshooting

| Problem | Fix |
|---|---|
| `Control channel is not connected` | The handshake has not arrived. The bot is still joining, or your `wss://` URL is not publicly reachable. |
| Bot joins but never connects back | Check `socket_connection_url` is `wss://`, not `ws://`, and that the tunnel is still up |
| Audio plays too fast or too slow | The file is not 48 kHz mono. Re-encode with the ffmpeg command above. |
| Audio has gaps | Increase the pacing lead (send chunks sooner) or use larger chunks |
| `interrupt` does nothing | Expected on Zoom and Teams. Only Google Meet clears the queue. |
| `sendmsg` works on one platform but not another | Set both `message` and `msg` to the same value |
| Camera feed unchanged after `sendimg_url` | The URL must be publicly reachable and return image bytes directly |
| Bot left behind in the meeting | `GET /bots/{bot_id}/remove_bot` (it really is a GET) |

## Related

- [`interactive-meeting-agent`](../interactive-meeting-agent): this control channel combined with live audio in, as a two-way loop
- [`send-chat-message`](../send-chat-message): the REST equivalent of `sendmsg`
- [`send-image-bot`](../send-image-bot): images into the chat rather than the camera feed

## Resources

- [Meeting control and command patterns](https://docs.meetstream.ai/guides/web-sockets/meeting-control-and-command-patterns)
- [Create Bot endpoint](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [MeetStream docs](https://docs.meetstream.ai)
