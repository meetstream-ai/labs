# Download Meeting Audio Recordings with the MeetStream API

Send a MeetStream meeting bot into a Zoom, Google Meet or Microsoft Teams call, wait for the `audio.processed` webhook, then download the finished audio recording to disk with a progress meter. Node.js, no SDK, only `express` and `dotenv`.

```bash
npm install && node index.js
```

## What it does

1. `POST /bots/create_bot` with `video_required: false` (audio-only recording).
2. Receives MeetStream lifecycle webhooks on `POST /webhook`.
3. On `audio.processed`, calls `GET /bots/{bot_id}/get_audio`.
4. Streams the recording into `recordings/<timestamp>_<bot_id>/`.

A bounded poll loop runs alongside the webhooks. Webhooks are not retried, so the poll loop is what actually guarantees this program finishes: it checks `GET /bots/{bot_id}/status` for a terminal state and then retries `get_audio` until it returns `200`.

## Prerequisites

- Node.js 18 or newer (uses built-in `fetch`)
- A MeetStream API key: https://app.meetstream.ai
- A meeting link (Google Meet, Zoom, or Microsoft Teams)
- Optional but recommended: a public HTTPS URL for webhooks, e.g. `ngrok http 3000`

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/audio-recording-downloader
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

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>` |
| `MEETING_LINK` | yes | Zoom, Google Meet or Teams meeting URL the bot joins |
| `PUBLIC_WEBHOOK_URL` | no | Public HTTPS base URL; `callback_url` becomes `<url>/webhook`. Blank = poll-only mode |
| `PORT` | no | Local webhook port (default `3000`) |
| `BOT_NAME` | no | Display name in the meeting (default `MeetStream Audio Recorder`) |
| `OUTPUT_DIR` | no | Where audio is written (default `./recordings`) |
| `RETENTION_HOURS` | no | Timed retention in hours; `0` keeps the default 30 days (720 h) |
| `EVERYONE_LEFT_TIMEOUT` | no | Seconds the bot stays after everyone else left (default `60`) |
| `POLL_MAX_ATTEMPTS` | no | Cap on download polls (default `80`) |
| `POLL_INTERVAL_MS` | no | Delay between polls (default `15000`) |
| `REQUEST_TIMEOUT_MS` | no | Per-request timeout (default `30000`) |
| `MAX_RETRIES` | no | Retries for 429/5xx (default `4`) |
| `LOG_LEVEL` | no | `silent`, `error`, `warn`, `info` (default) or `debug` |

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

`create_bot` is sent with an `Idempotency-Key` header, so a retried create returns `507` instead of spawning a second bot. 4xx responses other than 404 and 429 are never retried.

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

Typical order: `bot.joining` -> `bot.in_waiting_room` -> `bot.inmeeting` -> `bot.recording` -> `bot.leaving` -> `bot.stopped` -> `manifest.completed` / **`audio.processed`** (order varies) -> `transcription.processed` (post-call providers only) -> `video.processed` -> `bot.done` -> `data_deletion`. `bot.done` is the final event on every path; `audio.processed` only means the audio is ready.

Every ending arrives once as `event: "bot.stopped"`, and `bot_event` gives the reason: `bot.stopped` (clean exit, 200), `bot.kicked` (a participant removed the bot, 200), `bot.notallowed` (waiting-room timeout, 500), `bot.denied` (host denied, 500), `bot.failed` (crashed, usually 500). Branch on `bot_event`, not `bot_status`: a kick and a clean exit both report `Stopped`. The template falls back to `bot_status` (case-insensitive) only when `bot_event` is missing. On `bot.notallowed` or `bot.denied` nothing was recorded, so it stops instead of polling; a kicked bot still has a recording to download.

### Response shape

`get_audio` either streams the media file back directly or returns JSON pointing at a presigned storage URL (which expires, so download promptly). The template handles both: it checks `Content-Type`, and when the response is JSON it writes the raw body to `raw_get_audio_response.json` next to the download and walks it for downloadable URLs. That dump is the fastest way to see exactly what your account returned.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing required environment variable "MEETSTREAM_API_KEY"` | `.env` missing or empty | `cp .env.example .env` and fill it in |
| 401 / 403 | 401 = no key sent, 403 = wrong key | Check for a stray quote or trailing whitespace in `.env` |
| 400 on `create_bot` | Missing `meeting_link` or `bot_name`, or an unsupported link | Use a full Zoom / Meet / Teams URL |
| `get_audio` keeps returning 404 | Processing has not started; normal while the bot is still in the meeting | If it persists after `bot.stopped`, check `GET /bots/{bot_id}/detail` |
| Stuck on 202 | Still processing | The loop caps at `POLL_MAX_ATTEMPTS`; raise it for very long meetings |
| No webhooks arriving | Tunnel URL not public HTTPS, or ngrok restarted with a new URL | `curl https://your-tunnel/healthz`; create a new bot after changing the URL |
| `bot.stopped` with `bot_event: bot.notallowed` / `bot.denied` | Never admitted or host refused | Nothing was recorded; admit the bot faster or lower the lobby timeout |
| 507 on `create_bot` | Idempotent replay of the same `Idempotency-Key` | Success; the original bot is reused |

## Related

- [Retrieve recordings](https://docs.meetstream.ai/guides/transcription-recordings/retrieve-recordings)
- [Get bot audio](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-audio)
- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Usage and retention](https://docs.meetstream.ai/guides/features/usage-and-retention)
- [Error codes](https://docs.meetstream.ai/errors)
- Video version of this template: [../video-recording-downloader](../video-recording-downloader)
