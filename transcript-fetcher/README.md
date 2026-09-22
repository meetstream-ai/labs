# Fetch a Finished Meeting Transcript with the MeetStream API

Fetch the post-call transcript of a Zoom, Google Meet or Microsoft Teams meeting a MeetStream bot recorded, starting from nothing but the `bot_id`: resolve the `transcript_id`, poll through HTTP 202 with a cap, and parse the segments correctly (`speaker` + `transcript`, not `text`). This is the reference implementation of transcript retrieval.

```bash
cp .env.example .env      # add MEETSTREAM_API_KEY
npm install
node index.js <bot_id>
```

## What it does

Four steps, in order:

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
git clone https://github.com/meetstream-ai/labs.git
cd labs/transcript-fetcher
npm install
cp .env.example .env      # set MEETSTREAM_API_KEY; everything else is optional
node index.js <bot_id>
```

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>`. |
| `BOT_ID` | one of | Bot to fetch for. The first CLI argument overrides it. |
| `TRANSCRIPT_ID` | one of | Skip resolution and fetch this id directly. |
| `RAW` | no | `true` sends `?raw=true` for the provider's untouched output. Default `false`. |
| `MAX_POLL_ATTEMPTS` | no | Hard cap on 202 retries. Default `24`. |
| `POLL_INTERVAL_MS` | no | Delay between retries. Default `5000`. |
| `OUTPUT_DIR` | no | Where `.json` and `.txt` are written. Default `transcripts`. |
| `MEETSTREAM_API_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |

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

Webhooks are **not** a source. The lifecycle payload carries `event`, `bot_event`, `bot_id`, `bot_status`, `message`, `status_code`, `timestamp` and `custom_attributes` - no `transcript_id`. When `transcription.processed` arrives, you still have to resolve the id yourself. `src/resolve.js` does source 2, then falls back to source 3.

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

`src/client.js` sends `Authorization: Token <key>`, surfaces the API's `message` on every error, never retries a 4xx, and treats HTTP 507 (idempotent replay) as success.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `MEETSTREAM_API_KEY is not set` | No `.env`, or an empty key. | `cp .env.example .env` and paste your key. |
| `HTTP 401` | No key reached the API. | Check `.env` is loaded from the directory you ran `node` in. |
| `HTTP 403` | The key was rejected. | Check it is correct and active; regenerate if needed. |
| `HTTP 404` on `/transcript/...` | You passed a `bot_id` where a `transcript_id` was expected (they are different ids), or the recording expired via its retention window (default 30 days). | Let the template resolve the id from the `bot_id`. |
| Transcript prints as blank lines | You read `segment.text`. | The field is `segment.transcript`. |
| `HTTP 202` on every attempt, then the retry cap | The bot used a `*_streaming` provider. Streaming-only bots never produce a post-call transcript. | Use [re-transcribe-audio](../re-transcribe-audio) to run a post-call provider over the recorded audio. |
| `No transcriptions exist for bot ...` | The bot was created without `recording_config.transcript.provider`, or transcription has not started. | Wait for the `transcription.processed` webhook, then retry. |
| Newest run has `status: "Failed"` | Transcription failed (you would also have received `transcription.failed` with `status_code: 500`). | Re-run it with [re-transcribe-audio](../re-transcribe-audio), optionally with a different provider. |

## Related

- [Get transcription](https://docs.meetstream.ai/api-reference/api-endpoints/transcription/get-transcription)
- [Get bot transcriptions](https://docs.meetstream.ai/api-reference/api-endpoints/transcription/get-bot-transcriptions)
- [Get bot details](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-details)
- [Post-call transcription](https://docs.meetstream.ai/guides/transcription-recordings/post-call-transcription)
- [Retrieve recordings](https://docs.meetstream.ai/guides/transcription-recordings/retrieve-recordings)
- [Usage and retention](https://docs.meetstream.ai/guides/features/usage-and-retention)
- Sibling templates: [post-call-transcription](../post-call-transcription) is the full webhook-driven flow from bot creation to transcript; [re-transcribe-audio](../re-transcribe-audio) re-runs transcription on an existing bot with a different provider; [speaker-diarization](../speaker-diarization) turns a transcript into per-speaker turns and talk-time stats.
