# transcript-fetcher

Fetch a finished MeetStream transcript from a `bot_id`: resolve the `transcript_id`, poll through HTTP 202, and parse the segments correctly.

```bash
cp .env.example .env      # add MEETSTREAM_API_KEY
npm install
node index.js <bot_id>
```

## What it does

This is the reference implementation of transcript retrieval. Four steps, in order:

1. **Resolve the `transcript_id`.** It is not the `bot_id`, and it is never included in webhook payloads.
2. **Call `GET /transcript/{transcript_id}/get_transcript`.** Keyed by transcript, not by bot.
3. **Handle HTTP 202** - "still processing" - with capped polling.
4. **Parse segments using `speaker` + `transcript`.** Not `text`.

## Prerequisites

- Node.js 18 or newer (uses built-in `fetch`)
- A MeetStream API key from [app.meetstream.ai](https://app.meetstream.ai)
- A bot that has already run with a **post-call** transcription provider (`deepgram`, `assemblyai`, `sarvam`, `jigsawstack`, or `meetstream`)

## Setup

```bash
cp .env.example .env
```

Set `MEETSTREAM_API_KEY`. Everything else is optional.

## Run

```bash
node index.js <bot_id>            # resolve, fetch, print, save
BOT_ID=<bot_id> node index.js     # same, via .env
TRANSCRIPT_ID=<id> node index.js  # skip resolution
RAW=true node index.js <bot_id>   # untouched provider output
```

Output is printed and written to `transcripts/<transcript_id>.json` and `transcripts/<transcript_id>.txt`.

## How it works

### Step 1 - where `transcript_id` comes from

There are exactly three sources. In order of preference:

| Source | When to use it |
|---|---|
| `POST /bots/create_bot` response - `{ bot_id, transcript_id, ... }` | Best. Store it at creation time and you never look it up again. |
| `GET /bots/{bot_id}/detail` | You only kept the `bot_id`. |
| `GET /bots/{bot_id}/transcriptions` | You only kept the `bot_id`, or the bot has several transcription runs (for example after a re-transcribe). |

Webhooks are **not** a source. The lifecycle payload carries `event`, `bot_id`, `bot_status`, `message`, `status_code`, and `custom_attributes` - no `transcript_id`. When `transcription.processed` arrives, you still have to resolve the id yourself. `src/resolve.js` does source 2, then falls back to source 3.

`GET /bots/{bot_id}/transcriptions` returns every run:

```json
{ "bot_id": "...", "transcriptions": [
  { "transcript_id": "...", "provider": "deepgram", "status": "Success",
    "created_at": "...", "config": {},
    "download_urls": { "raw_transcript": "...", "processed_transcript": "..." } }
]}
```

This template prefers the newest run with `status: "Success"`, and falls back to the newest run of any status so a failure is visible rather than silent.

### Step 2 - fetching

```
GET /transcript/{transcript_id}/get_transcript?raw=false
Authorization: Token <your key>
```

`raw=false` (the default) returns MeetStream's processed segments. `raw=true` returns whatever the provider produced, whose shape varies per provider.

### Step 3 - HTTP 202 and capped polling

`202` is not an error. It means the transcript exists but is not ready. Poll again.

The important part is the cap. **A bot created with a `*_streaming` provider returns 202 forever** - streaming providers deliver transcripts live over your webhook and never produce a post-call transcript, so there is nothing for this endpoint to return, ever. An uncapped retry loop against a streaming-only bot spins until you kill it. This template stops after `MAX_POLL_ATTEMPTS` and tells you why.

### Step 4 - parsing the segments

A processed transcript is an array of segments:

```json
[
  {
    "speaker": "Alice",
    "transcript": "Can you walk me through pricing?",
    "start_time": 12.4,
    "end_time": 15.1,
    "words": [
      { "word": "Can", "punctuated_word": "Can", "start": 12.4, "end": 12.6,
        "confidence": 0.99, "speaker": 0, "speaker_confidence": 0.98 }
    ]
  }
]
```

**The text field is `transcript`, not `text`.** This is the single most common MeetStream integration bug: `segment.text` is `undefined`, so the loop runs fine, produces no error, and writes a transcript of blank lines. If your output is empty but the API returned 200, check this first.

```js
// Wrong - silently produces undefined
segments.map((s) => `${s.speaker}: ${s.text}`);

// Right
segments.map((s) => `${s.speaker}: ${s.transcript}`);
```

`src/transcript.js` also merges consecutive segments from the same speaker into readable turns, and handles a numeric `speaker` (which diarization can emit when no display name is available) by labelling it `Speaker 0`, `Speaker 1`, and so on.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MEETSTREAM_API_KEY` | - | Required. Sent as `Authorization: Token <key>`. |
| `BOT_ID` | - | Bot to fetch for. The first CLI argument overrides it. |
| `TRANSCRIPT_ID` | - | Skip resolution and fetch this id directly. |
| `RAW` | `false` | `true` → `?raw=true`, provider-raw output. |
| `MAX_POLL_ATTEMPTS` | `24` | Hard cap on 202 retries. |
| `POLL_INTERVAL_MS` | `5000` | Delay between retries. |
| `OUTPUT_DIR` | `transcripts` | Where `.json` and `.txt` are written. |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Transcript prints as blank lines | You read `segment.text`. The field is `segment.transcript`. |
| `HTTP 202` on every attempt, then the retry cap | The bot used a `*_streaming` provider. Streaming-only bots never produce a post-call transcript. Use `re-transcribe-audio` to run a post-call provider over the recorded audio. |
| `No transcriptions exist for bot ...` | The bot was created without `recording_config.transcript.provider`, or transcription has not started. Wait for the `transcription.processed` webhook. |
| `HTTP 401` | `MEETSTREAM_API_KEY` is not set. |
| `HTTP 403` | The key was rejected. Check it is correct and active. |
| `HTTP 404` on `/transcript/...` | You passed a `bot_id` where a `transcript_id` was expected. They are different ids. |
| Newest run has `status: "Failed"` | Transcription failed (you would also have received `transcription.failed` with `status_code: 500`). Re-run it with `re-transcribe-audio`, optionally with a different provider. |

## Related templates

- `post-call-transcription` - full webhook-driven flow, bot creation through transcript
- `re-transcribe-audio` - re-run transcription on an existing bot with a different provider
- `speaker-diarization` - turn a transcript into per-speaker turns and talk-time stats
