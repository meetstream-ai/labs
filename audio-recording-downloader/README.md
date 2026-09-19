# audio-recording-downloader

Send a MeetStream bot into a meeting, wait for the `audio.processed` webhook, then download the finished audio recording to disk with a progress meter.

```bash
npm install && node index.js
```

## What it does

1. `POST /bots/create_bot` with `video_required: false` (audio-only recording).
2. Receives MeetStream lifecycle webhooks on `POST /webhook`.
3. On `audio.processed`, calls `GET /bots/{bot_id}/get_audio`.
4. Streams the recording into `recordings/<timestamp>_<bot_id>/`.

A bounded poll loop runs alongside the webhooks. Webhook delivery is best-effort, so the poll loop is what actually guarantees this program finishes: it checks `GET /bots/{bot_id}/status` for a terminal state and then retries `get_audio` until it returns `200`.

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

Leave `PUBLIC_WEBHOOK_URL` blank to skip the webhook server entirely and rely on polling.

## Run

```bash
node index.js
```

Output:

```
recordings/
  2026-08-23_10-14-02_bot_abc123/
    audio.mp3
```

Press `Ctrl+C` at any point to pull the bot out of the meeting (`GET /bots/{bot_id}/remove_bot`) and download whatever MeetStream has finished processing. A second `Ctrl+C` exits immediately.

## How it works

### Auth and errors

Every request sends `Authorization: Token <key>` - literally the word `Token`, not `Bearer`. Error bodies are `{ "message": "..." }` and `src/client.js` surfaces that message on every failure.

Status codes this template handles explicitly:

| Status | Meaning | Behaviour |
|---|---|---|
| 200 / 201 | Success | Continue |
| 202 | Still processing | Poll again (capped) |
| 404 on `get_audio` | Processing has not started | Poll again |
| 429, 5xx | Transient | Retry with exponential backoff, honouring `Retry-After` |
| **507** | **Idempotent replay of a request you already sent** | **Treated as success** |

`create_bot` is sent with an `Idempotency-Key` header, so a retried create returns `507` instead of spawning a second bot.

### Webhook lifecycle

Every delivery carries `event` (the generic name). Most also carry `bot_event` (the specific name, which on terminals is the reason), and every one carries an ISO 8601 `timestamp`:

```json
{
  "event": "audio.processed",
  "bot_event": "audio.processed",
  "bot_id": "...",
  "bot_status": "Stopped",
  "message": "...",
  "status_code": 200,
  "timestamp": "2026-01-15T10:30:45Z",
  "custom_attributes": {}
}
```

Typical order: `bot.joining` → `bot.in_waiting_room` → `bot.inmeeting` → `bot.recording` → `bot.leaving` → `bot.stopped` → `manifest.completed` / **`audio.processed`** (order varies) → `transcription.processed` → `video.processed` → `bot.done` → `data_deletion`. `bot.done` is the final event on every path; `audio.processed` only means the audio is ready.

Every ending arrives once as `event: "bot.stopped"`, and `bot_event` gives the reason: `bot.stopped` (clean exit, 200), `bot.kicked` (a participant removed the bot, 200), `bot.notallowed` (waiting-room timeout, 500), `bot.denied` (host denied, 500), `bot.failed` (crashed, usually 500). Branch on `bot_event`, not `bot_status`: a kick and a clean exit both report `Stopped`. The template falls back to `bot_status` (case-insensitive) only when `bot_event` is missing. On `bot.notallowed` or `bot.denied` nothing was recorded, so it stops instead of polling; a kicked bot still has a recording to download.

### Response shape

`get_audio` either streams the media file back directly or returns JSON pointing at a storage URL. The template handles both: it checks `Content-Type`, and when the response is JSON it writes the raw body to `raw_get_audio_response.json` next to the download and walks it for downloadable URLs. That dump is the fastest way to see exactly what your account returned.

## Troubleshooting

**`Missing required environment variable "MEETSTREAM_API_KEY"`** - copy `.env.example` to `.env` and fill it in.

**401 / 403** - 401 means no key was sent, 403 means the key is wrong. Check for a stray quote or trailing whitespace in `.env`.

**`get_audio` keeps returning 404** - processing has not started. This is normal while the bot is still in the meeting. If it persists after `bot.stopped`, confirm the bot actually recorded something (`GET /bots/{bot_id}/detail`).

**Stuck on 202 forever** - 202 means "still processing". The loop caps itself at `POLL_MAX_ATTEMPTS`; raise it for very long meetings.

**No webhooks arriving** - the tunnel URL must be HTTPS and reachable from the public internet. Verify with `curl https://your-tunnel/healthz`. Restarting `ngrok` gives you a new URL, so the bot you already created is still pointing at the old one.

**409 on create** - a deduplication conflict; a bot for this meeting already exists.

## Reference

- [MeetStream docs](https://docs.meetstream.ai)
- [API reference](https://docs.meetstream.ai/api-reference)
