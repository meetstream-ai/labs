# Download Meeting Video Recordings with the MeetStream API

Send a MeetStream API bot into a Zoom, Google Meet or Microsoft Teams meeting with video recording enabled, wait for the `video.processed` webhook (with a capped status poll as backup), then download the finished MP4 recording to disk with a progress meter.

```bash
npm install && cp .env.example .env && node index.js
```

## What it does

1. `POST /bots/create_bot` with `video_required: true`.
2. Receives MeetStream lifecycle webhooks on `POST /webhook`.
3. On `video.processed`, calls `GET /bots/{bot_id}/get_video`.
4. Streams the recording into `recordings/<timestamp>_<bot_id>/`.

`video.processed` fires *after* `audio.processed` in MeetStream's lifecycle, so audio finishing first is expected. A bounded poll loop runs alongside the webhooks: webhook delivery is best-effort, so polling `GET /bots/{bot_id}/status` plus retrying `get_video` is what actually guarantees this program finishes.

## Prerequisites

- Node.js 18 or newer (uses built-in `fetch`)
- A MeetStream API key: https://app.meetstream.ai
- A meeting link (Google Meet, Zoom, or Microsoft Teams)
- Optional but recommended: a public HTTPS URL for webhooks, e.g. `ngrok http 3000`

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/video-recording-downloader
npm install
cp .env.example .env
```

Fill in `.env`:

```env
MEETSTREAM_API_KEY=your_api_key_here
MEETING_LINK=https://meet.google.com/abc-defg-hij
PUBLIC_WEBHOOK_URL=https://your-subdomain.ngrok-free.app
```

Leave `PUBLIC_WEBHOOK_URL` blank to skip the webhook server and rely on polling.

## Environment variables

| Name | Required | Default | Meaning |
|---|---|---|---|
| `MEETSTREAM_API_KEY` | yes | | API key, sent as `Authorization: Token <key>`. |
| `MEETING_LINK` | yes | | Google Meet, Zoom or Teams link. |
| `PUBLIC_WEBHOOK_URL` | no | | Public HTTPS base URL; `callback_url` is `<PUBLIC_WEBHOOK_URL>/webhook`. Blank = poll-only. |
| `PORT` | no | `3000` | Local webhook server port. |
| `BOT_NAME` | no | `MeetStream Video Recorder` | Display name in the meeting. |
| `OUTPUT_DIR` | no | `./recordings` | Where the video is written. |
| `RETENTION_HOURS` | no | `0` | Auto-delete after N hours. `0` keeps the API default of 720 (30 days). |
| `EVERYONE_LEFT_TIMEOUT` | no | `60` | Seconds the bot waits after everyone else leaves. |
| `POLL_MAX_ATTEMPTS` | no | `80` | Cap on `get_video` polls after the meeting ends. |
| `POLL_INTERVAL_MS` | no | `15000` | Delay between polls. |
| `REQUEST_TIMEOUT_MS` | no | `30000` | Per-request timeout. |
| `MAX_RETRIES` | no | `4` | Retries on 429 / 5xx. |
| `LOG_LEVEL` | no | `info` | `silent`, `error`, `warn`, `info` or `debug`. |

## Run

```bash
node index.js
```

Output:

```
recordings/
  2026-08-23_10-14-02_bot_abc123/
    video.mp4
```

Press `Ctrl+C` to pull the bot out of the meeting (`GET /bots/{bot_id}/remove_bot`) and download whatever is ready. A second `Ctrl+C` exits immediately.

## How it works

### Auth and errors

Every request sends `Authorization: Token <key>` - literally `Token`, not `Bearer`. Error bodies are `{ "message": "..." }` and `src/client.js` surfaces that message on every failure.

| Status | Meaning | Behaviour |
|---|---|---|
| 200 / 201 | Success | Continue |
| 202 | Still processing | Poll again (capped) |
| 404 on `get_video` | Processing has not started | Poll again |
| 429, 5xx | Transient | Retry with exponential backoff, honouring `Retry-After` |
| **507** | **Idempotent replay of a request you already sent** | **Treated as success** |

`create_bot` is sent with an `Idempotency-Key` header, so a retried create returns `507` instead of spawning a second bot.

### Why video takes longer

Composite video has to be encoded after the meeting ends, so `get_video` will legitimately return `202` for a while after `get_audio` already returns `200`. The default cap (`POLL_MAX_ATTEMPTS=80`, 15s apart) gives it about 20 minutes; raise it for long meetings.

### Response shape

`get_video` either streams the media file back directly or returns JSON pointing at a storage URL. The template handles both: it checks `Content-Type`, and when the response is JSON it writes the raw body to `raw_get_video_response.json` next to the download and walks it for downloadable URLs.

### Per-participant video

This template downloads the single composite recording. For one file per participant webcam and screen share, see the `per-participant-video-recorder` template in this repo (`GET /bots/{bot_id}/get_recording_streams`).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing required environment variable "MEETSTREAM_API_KEY"` | `.env` not created or key blank | Copy `.env.example` to `.env` and fill it in. |
| 401 | No key was sent | Set `MEETSTREAM_API_KEY`. |
| 403 | Key is wrong | Regenerate it in the dashboard. |
| 202 from `get_video` past the poll cap | Composite video is still encoding | Raise `POLL_MAX_ATTEMPTS` for long meetings. |
| `get_video` returns 404 forever | The bot never recorded: `bot.stopped` arrived with `bot_event: bot.notallowed` (waiting-room timeout) or `bot.denied` (host rejected it) | The template stops early on either. Check `GET /bots/{bot_id}/detail`. |
| 429 / 5xx | Transient | Retried with exponential backoff, honouring `Retry-After`. |
| 507 on `create_bot` | Idempotent replay | Treated as success; no second bot is created. |
| Downloaded file is far smaller than expected | The meeting was short, or the bot was removed early | The progress meter prints the byte count it actually wrote. |
| Download URL fails after a delay | Media URLs are presigned and expire | Re-run; the template fetches a fresh URL from `get_video`. |
| No webhooks arriving | Tunnel URL is not HTTPS or not publicly reachable, or `ngrok` restarted with a new URL | Test `curl https://your-tunnel/healthz`; an already-created bot keeps posting to the old URL, so polling still finishes the run. |

## Related

- [Get bot video](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-video)
- [Retrieve recordings](https://docs.meetstream.ai/guides/transcription-recordings/retrieve-recordings)
- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Local webhook server](https://docs.meetstream.ai/guides/webhooks/local-webhook-server)
- [Usage and retention](https://docs.meetstream.ai/guides/features/usage-and-retention)
- [Error codes](https://docs.meetstream.ai/errors)
- Labs: [audio-recording-downloader](../audio-recording-downloader), [per-participant-video-recorder](../per-participant-video-recorder), [webhook-local-tunnel](../webhook-local-tunnel)
