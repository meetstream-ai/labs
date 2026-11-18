# live-captions

Speaker-labelled captions from a live meeting, printed in your terminal as people talk.

A MeetStream bot joins the meeting with live transcription on, and streams transcript
chunks to a small server you run locally. Finals scroll past; the sentence in progress
is rewritten in place on the line below.

```
• bot joined the meeting
• recording started — captions will appear as people talk
[10:21:43] Priya: Can you walk me through the numbers?
[10:21:49] Sam: Sure, revenue is up.
  Priya: And on the pipeline side…
```

## How it works

Live transcription in MeetStream is an **HTTPS webhook**, not a WebSocket: the bot POSTs
a chunk every ~250 ms to a URL you expose.

```
meeting ──► MeetStream bot ──► POST /live-transcript ──► your terminal
                           └─► POST /webhook (bot joined, recording, left)
```

The bot is created with:

- `recording_config.transcript.provider: {"meetstream_streaming": {}}` — MeetStream's own
  streaming transcription. No third-party provider or extra key, and it reports real
  speaker names from the meeting.
- `video_required: false` — audio only. Captions, speakers and diarization all work
  without video, and nothing is spent compositing or storing a video file.
- `retention.hours` (default 24) for the stored audio.

Because the provider is streaming-only, **there is no post-call transcript**: the live
stream is the record. `transcription.processed` never fires and a transcript fetch would
return 202 forever. If you want a transcript afterwards, call
`POST /bots/{bot_id}/transcribe` with a post-call provider once the meeting ends.

## Setup

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -e ".[dev]"
cp .env.example .env     # then fill in MEETSTREAM_API_KEY and PUBLIC_BASE_URL
```

See `.env.example` for every setting. The two that matter:

| Variable | Why |
|---|---|
| `MEETSTREAM_API_KEY` | From https://app.meetstream.ai/api-keys. Only `join` and `leave` use it. |
| `PUBLIC_BASE_URL` | Public **https** URL that forwards to this server. MeetStream will not deliver to `http://` or to `localhost`. |

## Run it

Try the display first — no key, no meeting, no API calls:

```bash
.venv/bin/live-captions demo
```

Then, for a real meeting, in three terminals:

```bash
# 1. the local server (binds to 127.0.0.1 only)
.venv/bin/live-captions serve

# 2. a tunnel; paste the https URL it prints into PUBLIC_BASE_URL in .env
cloudflared tunnel --url http://127.0.0.1:8080

# 3. send the bot in (asks for confirmation first)
.venv/bin/live-captions join "https://meet.google.com/abc-defg-hij"
```

Captions appear in terminal 1 as people talk. To pull the bot out early:

```bash
.venv/bin/live-captions leave <bot_id>
```

## Endpoints on the local server

| Route | Purpose |
|---|---|
| `POST /live-transcript` | Live transcript chunks from the bot |
| `POST /webhook` | Bot lifecycle events (joining, recording, stopped, done) |
| `GET /healthz` | Liveness check |

Both POST routes always answer quickly and never raise — MeetStream does not retry a
failed delivery. Lifecycle events are deduped on `{bot_id, bot_event, timestamp}`, since
`bot.joining` can arrive more than once.

If you set a webhook secret in the MeetStream dashboard, put it in
`MEETSTREAM_WEBHOOK_SECRET` and signed deliveries are verified with HMAC-SHA256;
a bad signature gets a 401.

## Tests

```bash
.venv/bin/python -m pytest
```

The suite is fully offline: the API client is driven through `httpx.MockTransport` and
the server through `TestClient`, so no test needs a key or a network.

## Run against the local mock (no API key, no meeting)

[`../mock-meetstream`](../mock-meetstream) is a small offline stand-in for the MeetStream API. It answers with the same request and response shapes, and it plays a short meeting (lifecycle webhooks, live transcript, post-call files) when asked. `mock_e2e.py` starts the mock, runs this app against it, and prints PASS or FAIL.

```bash
python3 -m venv .venv && .venv/bin/pip install -U pip && .venv/bin/pip install -e ".[dev]"
python3 mock_e2e.py
```
