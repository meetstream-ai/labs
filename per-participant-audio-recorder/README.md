# Record Per-Participant Audio Streams with the MeetStream API

Send a MeetStream meeting bot into a Zoom, Google Meet or Microsoft Teams call, then download one audio file per participant from `GET /bots/{bot_id}/get_audio_streams`, with the HTTP 202 "still processing" state handled correctly and every poll loop capped.

## What it does

1. `POST /bots/create_bot` requesting separate per-participant audio.
2. Waits for the meeting to end (`bot.stopped` webhook, or polling `GET /bots/{bot_id}/status`).
3. Polls `GET /bots/{bot_id}/get_audio_streams` while it answers `202`.
4. Once it answers `200`, downloads every participant's stream into its own folder.

```
recordings/
  2026-08-23_10-14-02_bot_abc123/
    raw_get_audio_streams_response.json
    Alice Chen/
      audio.webm
    Bob Patel/
      audio_001.webm
      audio_002.webm
```

## The 202 problem (why this template exists)

Per-participant audio is produced by post-processing the recording after the meeting ends. Until that finishes, `get_audio_streams` returns **HTTP 202**, usually with a body like `{ "message": "in_progress" }`.

Two rules follow, and both are implemented in `src/streams.js` and `index.js`:

1. **202 is not an error.** Do not throw on it, do not retry it as a transient failure, and do not try to parse the body as media. It means "come back later".
2. **Cap the polling.** A bot configured with a *streaming-only* transcription provider (`deepgram_streaming`, `assemblyai_streaming`, `jigsawstack_streaming`, `meetstream_streaming`, `meeting_captions`) produces **no post-call per-participant audio at all**. Its `get_audio_streams` returns 202 forever. An uncapped loop hangs your process permanently.

The cap lives in `STREAMS_POLL_MAX_ATTEMPTS` (default 40 attempts x 15s = 10 minutes). When it trips, the error message tells you the streaming-provider case is the likely cause instead of failing silently.

The same distinction shows up in the webhook lifecycle: streaming-only bots never emit `transcription.processed`. They still end with `bot.done`, which is the final event on every path, so do not treat `audio.processed` as the end.

## Prerequisites

- Node.js 18 or newer (uses built-in `fetch`)
- A MeetStream API key from <https://app.meetstream.ai>
- A meeting link with more than one participant (otherwise there is nothing to separate)
- Optional but recommended: a public HTTPS URL for webhooks, e.g. `ngrok http 3000`

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/per-participant-audio-recorder
npm install
cp .env.example .env   # fill in MEETSTREAM_API_KEY and MEETING_LINK (PUBLIC_WEBHOOK_URL optional)
node index.js
```

Press `Ctrl+C` to pull the bot out of the meeting early and go straight to the download phase. A second `Ctrl+C` exits immediately.

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>`. |
| `MEETING_LINK` | yes | Zoom, Google Meet or Teams link the bot joins. |
| `PUBLIC_WEBHOOK_URL` | no | Public HTTPS base; `callback_url` becomes `<url>/webhook`. Unset means poll-only. |
| `PORT` | no | Local webhook server port. Default `3000`. |
| `BOT_NAME` | no | Display name in the meeting. Default `MeetStream Participant Recorder`. |
| `OUTPUT_DIR` | no | Where per-participant audio is written. Default `./recordings`. |
| `AUDIO_SEPARATE_STREAMS` | no | Send `audio_separate_streams: true` on create. Default `true`. |
| `EVERYONE_LEFT_TIMEOUT` | no | `automatic_leave.everyone_left_timeout` seconds. Default `60`. |
| `MEETING_POLL_MAX_ATTEMPTS` | no | Cap on status polls while waiting for the meeting to end. Default `240`. |
| `MEETING_POLL_INTERVAL_MS` | no | Delay between status polls. Default `15000`. |
| `STREAMS_POLL_MAX_ATTEMPTS` | no | Cap on `get_audio_streams` polls while it answers 202. Default `40`. |
| `STREAMS_POLL_INTERVAL_MS` | no | Delay between those polls. Default `15000`. |
| `REQUEST_TIMEOUT_MS` | no | Per-request timeout. Default `30000`. |
| `MAX_RETRIES` | no | Retries on network errors and 429/5xx. Default `4`. |
| `LOG_LEVEL` | no | `silent`, `error`, `warn`, `info` or `debug`. Default `info`. |

## How it works

### Requesting per-participant audio

The bot is created with `audio_separate_streams: true`, the same flag the `per-participant-video-recorder` template in this repo uses. If your account rejects it with a `400`, set `AUDIO_SEPARATE_STREAMS=false` in `.env` and ask MeetStream support whether per-participant audio is enabled for your plan; the download half of this template works either way, since it only reads `get_audio_streams`.

### Waiting for the meeting to end

With `PUBLIC_WEBHOOK_URL` set, the `bot.stopped` webhook is the fast path. Every ending arrives as `event: "bot.stopped"` with the reason in `bot_event` (`bot.stopped`, `bot.kicked`, `bot.notallowed`, `bot.denied`, `bot.failed`); `src/webhook.js` reads `bot_event` and only falls back to a case-insensitive `bot_status` comparison when it is missing. Without a webhook, `GET /bots/{bot_id}/status` is polled up to `MEETING_POLL_MAX_ATTEMPTS` times.

### Response shape

The body varies by account and meeting. `groupStreamsByParticipant()` handles a top-level array of stream objects, the nested `participants[].streams[].segments[]` shape, and a single object with a URL on it, then falls back to a generic walk for `http(s)` URLs so you never end up with an empty folder because of an unexpected key. Download URLs are presigned and expire, so download promptly.

Whatever comes back is written verbatim to `raw_get_audio_streams_response.json` in the output folder. Read that file first when something looks wrong.

### Status codes

| Status | Meaning | Behaviour |
|---|---|---|
| 200 | Streams ready | Download |
| **202** | **Still splitting audio** | **Wait and poll again, up to the cap** |
| 404 | Nothing to return yet | Poll again |
| 429, 5xx | Transient | Retry with exponential backoff |
| **507** | **Idempotent replay** | **Treated as success** |

`create_bot` is sent with an `Idempotency-Key`, so a retried create returns `507` rather than launching a second bot.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing required environment variable "MEETSTREAM_API_KEY"` | No `.env` or empty key. | `cp .env.example .env` and paste your key. |
| `MeetStream API error 401` / `403` | No key sent, or the key was rejected. | Check the key is complete and active for this workspace. |
| `MeetStream API error 400` on `create_bot` | The account rejects `audio_separate_streams`, or the link is invalid. | Set `AUDIO_SEPARATE_STREAMS=false`; the API's own `message` is printed with the error. |
| Bot stopped with `bot.notallowed` or `bot.denied` | Lobby timeout, or the host refused the bot. | Admit the bot next time; there is no recording to split. |
| Polling gave up after 40 attempts | Most likely a streaming-only transcription provider, which never produces post-call per-participant audio. | Use a post-call provider; if processing is genuinely slow, raise `STREAMS_POLL_MAX_ATTEMPTS`. |
| 200 but no files | `raw_get_audio_streams_response.json` contains no `http(s)` URLs: MeetStream returned metadata only. | Nothing was separated for that meeting. |
| Everyone lands in `unknown participant/` | The response carried URLs but no participant names. | Cross-reference `GET /bots/{bot_id}/get_participants` to label them. |
| Download fails with 403 | The presigned URL expired. | Re-run; the streams endpoint issues fresh URLs. |
| Only one participant folder | MeetStream can only separate participants it captured separately; a single dial-in mixing several people yields one stream. | Expected behaviour. |

## Related

- [Get audio streams](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-audio-streams)
- [Per-participant audio guide](https://docs.meetstream.ai/guides/transcription-recordings/per-participant-audio)
- [Retrieve recordings](https://docs.meetstream.ai/guides/transcription-recordings/retrieve-recordings)
- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Error reference](https://docs.meetstream.ai/errors)
- Templates: [per-participant-video-recorder](../per-participant-video-recorder/README.md) (`get_recording_streams`), [audio-recording-downloader](../audio-recording-downloader/README.md), [participant-tracker](../participant-tracker/README.md)
