# per-participant-audio-recorder

Record a meeting and download one audio file per participant from `GET /bots/{bot_id}/get_audio_streams` - with the HTTP 202 "still processing" state handled correctly.

```bash
npm install && node index.js
```

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

The cap lives in `STREAMS_POLL_MAX_ATTEMPTS` (default 40 attempts × 15s = 10 minutes). When it trips, the error message tells you the streaming-provider case is the likely cause instead of failing silently.

The same distinction shows up in the webhook lifecycle: streaming-only bots **end at `audio.processed`** and never emit `bot.done`.

## Prerequisites

- Node.js 18 or newer (uses built-in `fetch`)
- A MeetStream API key: https://app.meetstream.ai
- A meeting link with more than one participant (otherwise there is nothing to separate)
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

## Run

```bash
node index.js
```

Press `Ctrl+C` to pull the bot out of the meeting early and go straight to the download phase. A second `Ctrl+C` exits immediately.

## How it works

### Requesting per-participant audio

The bot is created with `audio_separate_streams: true`, the same flag the `per-participant-video-recorder` template in this repo uses. If your account rejects it with a `400`, set `AUDIO_SEPARATE_STREAMS=false` in `.env` and ask MeetStream support whether per-participant audio is enabled for your plan - the download half of this template works either way, since it only reads `get_audio_streams`.

### Response shape

The body varies by account and meeting. `groupStreamsByParticipant()` handles a top-level array of stream objects, the nested `participants[].streams[].segments[]` shape, and a single object with a URL on it - then falls back to a generic walk for `http(s)` URLs so you never end up with an empty folder because of an unexpected key.

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

**Polling gave up after 40 attempts** - most likely your bot used a streaming-only transcription provider, which never produces post-call per-participant audio. If you know the meeting was long and processing is genuinely slow, raise `STREAMS_POLL_MAX_ATTEMPTS`.

**200 but no files** - open `raw_get_audio_streams_response.json`. If it contains no `http(s)` URLs, MeetStream returned metadata only, meaning nothing was separated for that meeting.

**Everyone lands in `unknown participant/`** - the response carried URLs but no participant names. Cross-reference `GET /bots/{bot_id}/get_participants` to label them.

**400 on create_bot** - remove the separate-streams flag with `AUDIO_SEPARATE_STREAMS=false`. The API's own `message` is printed with the error.

**Only one participant folder** - MeetStream can only separate participants it actually captured separately; a single dial-in mixing several people in one room yields one stream.

## Reference

- [MeetStream docs](https://docs.meetstream.ai)
- [API reference](https://docs.meetstream.ai/api-reference)
- Sibling template: `per-participant-video-recorder` (`get_recording_streams`)
