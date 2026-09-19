# Send Images and GIFs into Meetings with the MeetStream API

Put an image or animated GIF into a Zoom, Google Meet or Microsoft Teams meeting through a MeetStream API bot: either into the meeting chat with `POST /bots/{bot_id}/send_image`, or as the bot's own camera feed over a control WebSocket with `sendimg_url` / `sendimg`.

```bash
npm install
cp .env.example .env    # add MEETSTREAM_API_KEY
node index.js --bot-id <bot_id> --img-url https://example.com/chart.png
```

## What it does

- **Chat mode** (default): validates that `img_url` is a public http(s) URL, then calls `send_image` on a bot that is already in a meeting.
- **Video-frame mode**: starts a local control WebSocket, exposes it publicly (`PUBLIC_URL` or ngrok), creates a bot with `socket_connection_url`, and on the bot's `ready` handshake sends `sendimg_url` (hosted image) or `sendimg` (base64 local file), optionally cycling a slideshow.
- `--dry-run` validates and prints the request without calling the API.

## The one rule: `img_url` must be a PUBLIC URL

```json
POST https://api.meetstream.ai/api/v1/bots/{bot_id}/send_image
Authorization: Token YOUR_API_KEY

{ "img_url": "https://example.com/chart.png", "display_duration": 5 }
```

MeetStream fetches that URL **from its own servers**, so:

- **No base64.** There is no `img`, `image_base64` or data-URI form of this endpoint. A `data:image/png;base64,…` value will not work.
- **No local paths.** `./chart.png` and `file:///…` are not URLs MeetStream can reach.
- **No localhost or LAN addresses.** `http://localhost:3000/chart.png`, `192.168.x.x` and `*.local` are unreachable from MeetStream's network.
- **The field is `img_url`**, not `image_url`.

Host the file somewhere public first: S3, Cloudinary, your CDN, a GitHub raw URL, a tunnel. The CLI validates all of this before it calls the API, so you get a readable message instead of an opaque `400`.

Animated GIFs are supported: pass a `.gif` URL like any other image.

## Two modes, two different things

| | chat mode (default) | video-frame mode |
|---|---|---|
| What the meeting sees | image in the **chat panel** | the bot's **camera tile** becomes the image |
| Transport | REST `POST /bots/{id}/send_image` | control WebSocket `sendimg_url` / `sendimg` |
| Needs a public URL for *the image* | yes | yes, for `sendimg_url` (`sendimg` takes base64) |
| Needs a public URL for *your server* | no | yes: the bot dials out to your socket |
| Works on an existing bot | yes, any `--bot-id` | no: the bot must have been created with `socket_connection_url` |

## Prerequisites

- Node.js 18 or newer
- A MeetStream API key ([app.meetstream.ai](https://app.meetstream.ai))
- Chat mode: a bot already in a meeting
- Video-frame mode: a meeting link, plus `PUBLIC_URL` or `NGROK_AUTHTOKEN`

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/send-image-bot
npm install
cp .env.example .env    # add MEETSTREAM_API_KEY
node index.js --help
```

## Usage

**Image into the meeting chat**

```bash
node index.js --bot-id 5b0ff6e7-3cea-4c9f-a6b4-851c5f11cf4f \
  --img-url https://example.com/q3-chart.png
```

**Animated GIF, displayed for 8 seconds**

```bash
node index.js --bot-id <id> --img-url https://example.com/wave.gif --display-duration 8
```

**Set the bot's camera feed to an image**

```bash
node index.js --mode video-frame \
  --meeting-link https://meet.google.com/abc-defg-hij \
  --img-url https://example.com/avatar.png
```

**Slideshow on the camera feed**

```bash
node index.js --mode video-frame --meeting-link <url> \
  --img-url https://example.com/slide1.png \
  --img-url https://example.com/slide2.png \
  --img-url https://example.com/slide3.png \
  --interval 15 --duration 300
```

**Local file as the camera feed**: `sendimg` carries base64 over your own socket, so no hosting is needed. This is the one place base64 is allowed, and it is *not* the chat endpoint:

```bash
node index.js --mode video-frame --meeting-link <url> --img-file ./logo.png
```

**Validate without calling the API**

```bash
node index.js --bot-id <id> --img-url https://example.com/x.png --dry-run
```

### Options

| Option | Description |
|---|---|
| `--mode <chat\|video-frame>` | Default `chat` |
| `--bot-id <id>` | Chat mode: the bot to post through |
| `--meeting-link <url>` | Video-frame mode: meeting to send a new bot into |
| `--bot-name <name>` | Display name for a newly created bot |
| `--img-url <url>` | Public image URL. Repeatable in video-frame mode. |
| `--img-file <path>` | Video-frame mode only: local image sent as base64 |
| `--display-duration <secs>` | Chat mode only |
| `--interval <secs>` | Slideshow interval, default `10` |
| `--duration <secs>` | Video-frame mode: run this long, then remove the bot |
| `--dry-run` | Validate and print, call nothing |
| `-h`, `--help` | Usage |

## How video-frame mode works

An existing bot has no control channel, so this mode creates its own:

1. A local WebSocket server starts on `/control`.
2. A public `wss://` URL is resolved (`PUBLIC_URL`, or an ngrok tunnel).
3. `POST /bots/create_bot` is called with `socket_connection_url: { websocket_url }` pointing at it.
4. The bot joins, connects back, and sends the handshake `{ "type": "ready", "bot_id": "...", "message": "..." }`.
5. We reply with the image command:

```json
{ "command": "sendimg_url", "bot_id": "bot_abc123", "img_url": "https://example.com/avatar.png" }
```

```json
{ "command": "sendimg", "bot_id": "bot_abc123", "img": "<base64 JPEG or PNG>" }
```

`socket_connection_url` points at **your** server. It is a bring-your-own bridge and has nothing to do with MIA: a MIA bot takes only `agent_config_id`.

The bot is removed on Ctrl+C, when `--duration` elapses, or when the socket closes, so a run never leaves it stranded in the meeting.

## Project structure

```
send-image-bot/
├─ index.js               # entry point: mode dispatch, validation, chat send
├─ src/
│   ├─ cli.js             # argument parsing + public-URL validation
│   ├─ video-frame.js     # control socket, bot creation, sendimg/sendimg_url
│   ├─ meetstream.js      # REST client (Token auth, retries, 507 handling)
│   ├─ tunnel.js          # PUBLIC_URL or ngrok
│   └─ logger.js          # zero-dependency terminal output
├─ .env.example
├─ package.json
└─ README.md
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | From the MeetStream dashboard |
| `PUBLIC_URL` | video-frame mode | An https:// address already pointing at this process |
| `NGROK_AUTHTOKEN` | video-frame mode | Opens a tunnel automatically |
| `PORT` | no | Local control-server port, default `3000` |
| `BOT_NAME` | no | Default display name for created bots. Default `MeetStream Labs Image Bot` |
| `MEETSTREAM_BASE_URL` | no | API base URL. Default `https://api.meetstream.ai/api/v1` |
| `NO_COLOR` | no | Set to anything to disable coloured terminal output |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing MEETSTREAM_API_KEY` | `.env` not created or key blank | `cp .env.example .env` and fill it in. |
| `401` / `403` from the API | Key missing or rejected | `Authorization: Token <key>`, not `Bearer`. Regenerate if it still fails. |
| `img_url cannot be a data: URI` | `send_image` has no base64 form | Host the image publicly and pass the link. |
| `img_url points at a private address` | `localhost`, `192.168.x.x` and `*.local` are unreachable from MeetStream | Use a public URL. |
| `400` from `send_image` | Wrong field name or type | The field is `img_url`, not `image_url`; `display_duration` must be an integer. |
| `404` | Wrong bot id, or the bot already left | Check `GET /bots/{bot_id}/status`. |
| `429` / `5xx` | Rate limit or transient error | The client retries with backoff. |
| `507` from `create_bot` | Idempotent replay | Treated as success; the earlier bot is used. |
| Image posts but shows broken | URL returns HTML (a Drive or Dropbox share page), not image bytes | Use the direct-file link. |
| Video-frame mode: no handshake | Bot never reached the meeting, or the `wss://` URL is not publicly reachable | Check `GET /bots/{bot_id}/status` and the tunnel. |
| Camera stays blank | The platform has not granted the bot a camera slot yet | Wait for `bot.inmeeting`, then send. |

## Related

- [Send image](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/send-image)
- [Chat and visuals](https://docs.meetstream.ai/guides/features/chat-and-visuals)
- [Meeting control and command patterns](https://docs.meetstream.ai/guides/websockets/meeting-control-patterns)
- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [Error codes](https://docs.meetstream.ai/errors)
- Labs: [send-chat-message](../send-chat-message) (text into the meeting chat), [websocket-bot-control](../websocket-bot-control) (the full control channel: audio, chat, interrupt, images)
