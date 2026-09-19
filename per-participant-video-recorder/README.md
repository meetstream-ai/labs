# Record Per-Participant Video and Audio with the MeetStream API

Send a MeetStream meeting bot into a Zoom, Google Meet or Microsoft Teams call with `video_separate_streams` and `audio_separate_streams` enabled, then save every participant's webcam, screen share and audio as separate local files. No audio/video merge, no FFmpeg.

For a non-technical setup guide, read [quickstart.md](quickstart.md).

```
recordings/
  2026-07-09_13-02-05/
    dharrun 17/
      webcam.mp4
      audio.webm
    Alice/
      webcam.mp4
      screen_share.mp4
```

## How it works

1. `npm start` starts a local Express webhook server on `PORT`, opens an ngrok tunnel to it, and creates a bot with `POST /bots/create_bot` (`video_separate_streams: true`, `audio_separate_streams: true`, `callback_url` pointing at the tunnel).
2. It waits for the meeting to end. Every ending arrives once as `event: "bot.stopped"`; `bot_event` gives the reason (`bot.stopped`, `bot.kicked`, `bot.notallowed`, `bot.denied`, `bot.failed`). The app branches on `bot_event` and falls back to a case-insensitive `bot_status` only when it is missing.
3. Ctrl+C removes the bot with `GET /bots/{bot_id}/remove_bot` (resent up to `BOT_STOP_MAX_ATTEMPTS` times) and waits for `bot.stopped`.
4. After the bot has stopped it polls `GET /bots/{bot_id}/get_recording_streams` and `GET /bots/{bot_id}/get_audio_streams` (bounded by `RECORDING_POLL_MAX_ATTEMPTS`) until MeetStream returns downloadable media URLs. `video.processed` / `audio.processed` webhooks are a fast path; the poll loop is the guarantee, because webhook deliveries are not retried.
5. Each item is saved into that participant's folder by media type. Media URLs are presigned and expire, so downloads start straight away.

The raw responses are also written to `recordings/<run-date-time>/debug_video_response.json` and `debug_audio_response.json` for troubleshooting.

The video response may be a top-level array:

```json
[
  {
    "participant": { "name": "dharrun 17" },
    "download_url": "https://...",
    "type": "webcam"
  }
]
```

Audio responses may use `participants[].streams[].segments[]`. Each downloadable item is saved into that participant's folder using its media type, for example `webcam.mp4` and `audio.webm`.

## Prerequisites

- Node.js 18 or newer
- A MeetStream API key from <https://app.meetstream.ai>
- An [ngrok authtoken](https://dashboard.ngrok.com/get-started/your-authtoken) so MeetStream can reach the local webhook server
- A Zoom, Google Meet or Teams meeting link you can admit a bot into

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/per-participant-video-recorder
npm install
cp .env.example .env   # then fill in MEETSTREAM_API_KEY, MEETING_LINK, NGROK_AUTHTOKEN
node index.js          # or: npm start
```

On Windows PowerShell, if `npm` is blocked by execution policy, use `npm.cmd start`.

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>` |
| `MEETING_LINK` | yes | Zoom, Google Meet or Teams meeting URL the bot joins |
| `NGROK_AUTHTOKEN` | yes | Opens the public tunnel for webhooks |
| `NGROK_DOMAIN` | no | Reserved ngrok domain; blank = random domain each run |
| `BOT_NAME` | no | Display name in the meeting (default `MeetStream Recorder`) |
| `PORT` | no | Local webhook port (default `3000`) |
| `OUTPUT_DIR` | no | Where recordings are written (default `./recordings`) |
| `LOG_LEVEL` | no | `fatal`, `error`, `warn`, `info` (default), `debug`, `trace`, `silent` |
| `MAX_RETRIES` | no | Retries for 429 / 5xx / timeouts (default `5`); 4xx is never retried |
| `RETRY_BASE_DELAY_MS` | no | Base backoff delay (default `1000`) |
| `REQUEST_TIMEOUT_MS` | no | Per-request timeout (default `30000`) |
| `MAX_MEETING_WAIT_MINUTES` | no | Safety timeout if `bot.stopped` never arrives (default `180`) |
| `BOT_STOP_MAX_ATTEMPTS` | no | How many times `remove_bot` is resent after Ctrl+C (default `6`) |
| `BOT_STOP_RETRY_MS` | no | Delay between those attempts (default `10000`) |
| `RECORDING_POLL_MAX_ATTEMPTS` | no | Cap on media-ready polls (default `20`) |
| `RECORDING_POLL_INTERVAL_MS` | no | Delay between media-ready polls (default `15000`) |

## Run

```bash
npm start
```

Admit the bot from the waiting room, hold the meeting, then either let it end or press Ctrl+C.

## Test

`test_downloader.mjs` is a local self-check. It does not join meetings, call MeetStream, or record anything; it verifies that participant audio/video files still save into the right folders.

```bash
npm test          # npm.cmd test on Windows PowerShell
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing required environment variable "MEETSTREAM_API_KEY"` | `.env` missing or empty | `cp .env.example .env` and fill it in |
| 401 / 403 | 401 = no key sent, 403 = wrong key | Check for stray quotes or whitespace in `.env` |
| 400 on `create_bot` | Bad `MEETING_LINK`, or an unsupported option | Use the full meeting URL |
| ngrok fails to start | Bad `NGROK_AUTHTOKEN`, or the reserved `NGROK_DOMAIN` is not yours | Fix the token, or clear `NGROK_DOMAIN` |
| `bot.stopped` with `bot_event: bot.notallowed` / `bot.denied` | Never admitted, or the host refused | Nothing was recorded; admit the bot from the lobby next time |
| `get_recording_streams` keeps returning 404 / 202 | Processing has not started or finished | Normal for a few minutes after `bot.stopped`; raise `RECORDING_POLL_MAX_ATTEMPTS` for long meetings |
| Video never becomes ready and `bot.stopped` was never confirmed | The bot may still be in the meeting | Check `GET /bots/{bot_id}/status`; remove it with `remove_bot` |
| No webhooks arriving | Tunnel restarted with a new URL after the bot was created | Create a new bot; `callback_url` is fixed at create time |
| Downloads fail with 403 | The presigned media URL expired | Re-run the poll; URLs are fetched fresh each attempt |

## Related

- [Per-participant video](https://docs.meetstream.ai/guides/transcription-recordings/per-participant-video)
- [Per-participant audio](https://docs.meetstream.ai/guides/transcription-recordings/per-participant-audio)
- [Get recording streams](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-recording-streams)
- [Get audio streams](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-audio-streams)
- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Local webhook server](https://docs.meetstream.ai/guides/webhooks/local-webhook-server)
- Related templates: [../per-participant-audio-recorder](../per-participant-audio-recorder), [../video-recording-downloader](../video-recording-downloader), [../webhook-local-tunnel](../webhook-local-tunnel)
