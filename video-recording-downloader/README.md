# video-recording-downloader

Send a MeetStream bot into a meeting with video recording enabled, wait for the `video.processed` webhook, then download the finished recording to disk with a progress meter.

```bash
npm install && node index.js
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

**`Missing required environment variable "MEETSTREAM_API_KEY"`** - copy `.env.example` to `.env` and fill it in.

**401 / 403** - 401 means no key was sent, 403 means the key is wrong.

**`get_video` returns 404 forever** - the bot may have joined but never recorded (denied entry, or nothing to record). Check `GET /bots/{bot_id}/detail` and the `bot_status` on the `bot.stopped` webhook: `NotAllowed` means it timed out in the waiting room, `Denied` means the host rejected it.

**Downloaded file is far smaller than expected** - the meeting itself was short, or the bot was removed early. The progress meter prints the byte count it actually wrote.

**No webhooks arriving** - the tunnel URL must be HTTPS and publicly reachable. Test with `curl https://your-tunnel/healthz`. A restarted `ngrok` gives a new URL, and the already-created bot keeps posting to the old one.

## Reference

- [MeetStream docs](https://docs.meetstream.ai)
- [API reference](https://docs.meetstream.ai/api-reference)
