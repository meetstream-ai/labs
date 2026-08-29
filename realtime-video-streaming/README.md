# Real-Time Video Streaming

Receive a MeetStream bot's live meeting video as fMP4 over a WebSocket, write it to a playable file while the meeting is still running, and relay the same bytes to your own consumers.

```bash
npm install
cp .env.example .env    # add MEETSTREAM_API_KEY, MEETING_LINK, NGROK_AUTHTOKEN
node index.js
```

## Prerequisites

- Node.js 18 or newer
- A MeetStream API key ([app.meetstream.ai](https://app.meetstream.ai))
- A public HTTPS endpoint: either your own (`PUBLIC_URL`) or a free ngrok authtoken (`NGROK_AUTHTOKEN`)
- A live **Google Meet** or **Microsoft Teams** link

> Live video is supported on Google Meet and Microsoft Teams only. It is **not** available on Zoom. For Zoom use post-call video (`video_required: true` plus `GET /bots/{bot_id}/get_video`).

## Setup

1. `npm install`
2. `cp .env.example .env`
3. Fill in `MEETSTREAM_API_KEY` and `MEETING_LINK`.
4. Give the process a public address: set `PUBLIC_URL` to an https:// host you control, or set `NGROK_AUTHTOKEN` and a tunnel is opened for you.
5. `node index.js`

## How it works

`create_bot` is called with `live_video_required`, which tells the bot to dial *out* to your WebSocket once it is in the meeting:

```json
POST https://api.meetstream.ai/api/v1/bots/create_bot
Authorization: Token YOUR_API_KEY

{
  "meeting_link": "https://meet.google.com/xxx-xxxx-xxx",
  "bot_name": "MeetStream Labs Video Bot",
  "video_required": false,
  "callback_url": "https://<public>/webhook",
  "live_video_required": { "websocket_url": "wss://<public>/video" },
  "recording_config": { "retention": { "type": "timed", "hours": 24 } },
  "automatic_leave": {
    "waiting_room_timeout": 600,
    "everyone_left_timeout": 60,
    "in_call_recording_timeout": 14400
  }
}
```

`websocket_url` points at **your** server. It is not a MeetStream-hosted bridge and it is unrelated to MIA (MIA takes only `agent_config_id`).

### Local endpoints

| Endpoint | Direction | Purpose |
|---|---|---|
| `POST /webhook` | MeetStream to you | Bot lifecycle events (`bot.joining` → `bot.inmeeting` → `bot.stopped`) |
| `WS /video` | MeetStream to you | The live fMP4 stream. This is the URL passed as `live_video_required.websocket_url`. |
| `WS /stream` | you to your apps | Relay of the same fMP4 bytes to local consumers |
| `GET /health` | - | Bot id, bytes received, relay consumer count |

### The wire protocol

| Message | Direction | Format | Contents |
|---|---|---|---|
| `video_stream_start` | MS to you | JSON text | `codec`, `audio_codec`, `container: "fmp4"`, `width`, `height`, `framerate`, `audio_sample_rate`, `audio_bitrate` |
| media chunks | MS to you | binary | fMP4 bytes. **Append in arrival order.** |
| `video_latency_ping` | MS to you | JSON text | `seq`, `sent_at_ms` |
| `video_latency_pong` | **you to MS** | JSON text | echo `seq` and `sent_at_ms`, add `server_received_at_ms` and `bot_id` |
| `video_stream_end` | MS to you | JSON text | `duration_seconds` |

### The ping/pong keepalive contract

Every `video_latency_ping` **must** be answered with a `video_latency_pong`. This is the liveness signal for the connection, and it is how delivery latency gets measured, so the reply is sent before any other work happens on that message (`src/video-sink.js`):

```js
// incoming
{ "type": "video_latency_ping", "bot_id": "bot-123", "seq": 42, "sent_at_ms": 1743500000123 }

// your reply: same seq, same sent_at_ms, plus your receive time
{ "type": "video_latency_pong", "seq": 42, "sent_at_ms": 1743500000123,
  "server_received_at_ms": 1743500000189, "bot_id": "bot-123" }
```

The latency figure printed in the terminal is `server_received_at_ms - sent_at_ms`. It is a wall-clock difference between two machines, so treat it as a trend line rather than an absolute: any clock skew between the bot host and yours is baked in.

## Output

fMP4 lands in `./output/<bot_id>-<timestamp>.mp4` as it streams.

```bash
ffplay output/bot-123-1743500000000.mp4          # play it
ffmpeg -i output/bot-123-*.mp4 -c copy final.mp4  # remux to a normal MP4
```

The file is written append-only, so it stays playable even if the process is killed mid-meeting: a fragmented MP4 does not need a trailing index the way a regular MP4 does.

## Relaying to your own consumers

Anything that consumes a byte stream can attach to `ws://localhost:3000/stream`:

```bash
# Terminal 1
node index.js

# Terminal 2
node consumer-example.js
```

A consumer receives the `video_stream_start` JSON, then binary fMP4 chunks, then `video_stream_end`. Consumers that connect mid-meeting are replayed the cached initialisation segment first so their decoder can start. See the note at the top of `src/relay.js` about how that segment is detected.

## Project structure

```
realtime-video-streaming/
├─ index.js               # entry point: server, tunnel, bot creation, shutdown
├─ consumer-example.js    # minimal reader of the /stream relay
├─ src/
│   ├─ meetstream.js      # REST client (Token auth, retries, 202/507 handling)
│   ├─ tunnel.js          # PUBLIC_URL or ngrok
│   ├─ video-sink.js      # the /video protocol: start, chunks, ping/pong, end
│   ├─ relay.js           # fan-out to /stream consumers, init-segment cache
│   └─ logger.js          # zero-dependency terminal output
├─ .env.example
├─ package.json
└─ README.md
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | From the MeetStream dashboard |
| `MEETING_LINK` | yes | Google Meet or Teams URL |
| `PUBLIC_URL` | one of these two | An https:// address already pointing at this process |
| `NGROK_AUTHTOKEN` | one of these two | Opens a tunnel automatically |
| `PORT` | no | Local port, default `3000` |
| `BOT_NAME` | no | Name shown in the participant list |
| `OUTPUT_DIR` | no | Default `./output` |
| `VIDEO_RECORDING` | no | `true` also produces a post-call downloadable recording |
| `MAX_RELAY_CLIENTS` | no | Default `5` |
| `RELAY_URL` | no | Used by `consumer-example.js` |

## Troubleshooting

| Problem | Fix |
|---|---|
| `Missing required env var` | Copy `.env.example` to `.env` and fill it in |
| `No public URL available` | Set `PUBLIC_URL` or `NGROK_AUTHTOKEN` |
| Bot joins but no `video_stream_start` | You are on Zoom. Live video is Google Meet and Teams only. |
| Connection opens then drops | Check pongs are going out. A consumer that stops answering `video_latency_ping` is treated as dead. |
| `1009` close code / oversized frame | Raise `maxPayload` on the WebSocket server; the default `ws` limit is far below a 1080p keyframe |
| Chunks arrive out of order downstream | Write sequentially per `bot_id`. The stream is order-dependent: fMP4 cannot be reassembled from shuffled chunks. |
| `401` / `403` from the API | `Authorization: Token <key>`, not `Bearer`. Regenerate the key if it still fails. |
| Bot left behind in the meeting | `GET /bots/{bot_id}/remove_bot` (it really is a GET) |

## Resources

- [Live video stream guide](https://docs.meetstream.ai/guides/live-video-stream)
- [Create Bot endpoint](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [MeetStream docs](https://docs.meetstream.ai)
