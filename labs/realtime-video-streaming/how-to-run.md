# Real-Time Video Streaming

Receive live video from a MeetStream bot over WebSocket while it is in the meeting. MeetStream streams fragmented MP4 (fMP4) data you can record or process in real time.

**Supported platforms:** Google Meet and Microsoft Teams only (not Zoom).

---

## Prerequisites

- Node.js 18+
- A MeetStream API key → [Get one here](https://app.meetstream.ai)
- A public WebSocket URL (use ngrok or cloudflared for local dev)

---

## 1. Install dependencies

```bash
cd realtime-video-streaming
npm install
```

---

## 2. Start the WebSocket server

```bash
node video-ws-server.js
```

The server listens on port **3002** by default. Recordings are saved to `./recordings/`.

---

## 3. Expose your local server publicly

MeetStream connects to your server as a WebSocket client — it needs a publicly reachable `wss://` URL.

**Option A — ngrok**

```bash
ngrok http 3002
# Copy the wss://xxxx.ngrok.io URL
```

**Option B — Cloudflare Tunnel**

```bash
cloudflared tunnel --url http://localhost:3002
```

> Use a dedicated tunnel for video streaming. Do not reuse a WebSocket endpoint used for transcription or other features.

---

## 4. Create a bot with live video

```bash
MEETSTREAM_API_KEY=your_key \
WEBSOCKET_URL=wss://xxxx.ngrok.io \
node create-bot-video.js <meeting_url>
```

Example:

```bash
MEETSTREAM_API_KEY=sk_live_xxx \
WEBSOCKET_URL=wss://abc123.ngrok.io \
node create-bot-video.js https://meet.google.com/abc-defg-hij
```

The bot joins the meeting and MeetStream opens a WebSocket connection to your server, streaming fMP4 video chunks.

> Auth header format: `Authorization: Token <your_api_key>` (not Bearer).

---

## Server endpoints

| Endpoint | Description |
|---|---|
| `WS /video` | Receives video stream (JSON control + binary fMP4) |
| `GET /health` | Health check |
| `GET /sessions/:botId` | View recording metadata for a session |

---

## WebSocket protocol

### Messages from MeetStream (text / JSON)

**`video_stream_start`** — sent once after connection:

```json
{
  "type": "video_stream_start",
  "bot_id": "bot-123",
  "speakerId": "spk_abc123",
  "speakerName": "Jane Smith",
  "codec": "h264",
  "audio_codec": "aac",
  "container": "fmp4",
  "width": 1920,
  "height": 1080,
  "framerate": 25,
  "audio_sample_rate": 44100,
  "audio_bitrate": "128k"
}
```

**`video_latency_ping`** — sent periodically. You must reply with `video_latency_pong`:

```json
{
  "type": "video_latency_ping",
  "bot_id": "bot-123",
  "seq": 42,
  "sent_at_ms": 1743500000123
}
```

**`video_stream_end`** — sent when the stream stops:

```json
{
  "type": "video_stream_end",
  "bot_id": "bot-123",
  "duration_seconds": 152.7
}
```

### Messages from MeetStream (binary)

Raw fMP4 bytes. Append chunks in order to build a continuous recording.

### Messages you send back (text / JSON)

Reply to every `video_latency_ping`:

```json
{
  "type": "video_latency_pong",
  "seq": 42,
  "sent_at_ms": 1743500000123,
  "server_received_at_ms": 1743500000189,
  "bot_id": "bot-123"
}
```

---

## WebSocket message field reference

| Field | Notes |
|---|---|
| `bot_id` | Unique identifier for this bot instance |
| `speakerId` | Stable participant ID — use to distinguish speakers with the same name |
| `speakerName` | Display name shown in the meeting |
| `codec` | Video codec (e.g., "h264", "vp9") |
| `audio_codec` | Audio codec (e.g., "aac", "opus") |
| `width`, `height` | Video resolution in pixels |
| `framerate` | Frames per second |
| `audio_sample_rate` | Audio sampling frequency in Hz |
| `audio_bitrate` | Audio bitrate (e.g., "128k") |

---

## Create bot payload reference

```json
{
  "meeting_link": "https://meet.google.com/abc-defg-hij",
  "video_required": true,
  "live_video_required": {
    "websocket_url": "wss://your-server.example.com/video"
  }
}
```

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3002` | Server listen port |
| `OUTPUT_DIR` | `./recordings` | Directory for saved `.mp4` files |
| `MEETSTREAM_API_KEY` | — | Required for `create-bot-video.js` |
| `WEBSOCKET_URL` | — | Public `wss://` base URL for `create-bot-video.js` |

---

## Extend it

Edit `onStreamComplete()` in `video-ws-server.js` to wire in your own logic:

- Upload recordings to S3 or cloud storage
- Pipe fMP4 chunks into a real-time processing pipeline
- Forward video to a frontend player via HLS or WebRTC

---

## Troubleshooting

| Symptom | What to check |
|---|---|
| No connection or no data | Confirm `video_required` is `true`, the URL is correct, and the meeting is Google Meet or Teams |
| No binary chunks | Confirm the tunnel or firewall allows inbound connections and TLS is valid for `wss://` |
| TLS or certificate errors | Verify certificates, tunnel URL, and that you use `wss://` in production |

---

## Resources

- [Real-Time Video Streaming docs](https://docs.meetstream.ai/guides/web-sockets/real-time-video-streaming)
- [API Reference](https://docs.meetstream.ai/api-reference)
