# multi-provider-transcription

Run any of MeetStream's five post-call transcription providers from one template, switched with a single environment variable.

```bash
cp .env.example .env      # add MEETSTREAM_API_KEY
npm install
PROVIDER=deepgram node index.js https://meet.google.com/xxx-xxxx-xxx
```

## What it does

Sends a bot to a meeting with the provider you choose, polls until the meeting ends, then fetches, prints, and saves the transcript. Run it again with a different `PROVIDER` against the same meeting and you have a side-by-side comparison.

The provider goes in exactly one place:

```json
{
  "recording_config": {
    "transcript": { "provider": { "deepgram": { "model": "nova-3", "language": "en" } } }
  }
}
```

**Exactly one key under `provider`.** Two keys is an HTTP 400.

## Provider comparison

| Provider | Key | Model field | Language field | Diarization field | Translation | Best for |
|---|---|---|---|---|---|---|
| Deepgram | `deepgram` | `model` (string, e.g. `"nova-3"`) | `language` - `"en"` | `diarize` | - | The general default. Fast, strong English accuracy. |
| AssemblyAI | `assemblyai` | `speech_models` (**array**) | `language_code` - `"en_us"` | `speaker_labels` | - | Rich post-processing: speaker labels, PII redaction, auto chapters. |
| Sarvam AI | `sarvam` | `model` (string) | `language_code` - `"hi-IN"` | `with_diarization` | - | Indic languages. Hindi, Tamil, Telugu, Kannada, Bengali and friends. |
| JigsawStack | `jigsawstack` | - | `language` - `"auto"` | `by_speaker` | `translate` | Unknown or mixed language input; translate to English in one pass. |
| MeetStream | `meetstream` | - | `language` - `"auto"` | - | `translate` | In-house engine. No third-party vendor in the path. |

### The field-shape trap

Deepgram and AssemblyAI do not take the same fields, and the difference is not cosmetic:

```json
{ "deepgram":   { "model": "nova-3",        "language": "en" } }
{ "assemblyai": { "speech_models": ["..."], "language_code": "en_us" } }
```

`speech_models` is **plural and an array**; the language key is `language_code`, not `language`. Sending Deepgram's shape to AssemblyAI produces an HTTP 400 (or silently ignored options, depending on the field). MeetStream passes provider options through to the upstream vendor rather than flattening them into a shared schema, so each provider speaks its own dialect.

This template's `src/providers.js` builds the correct shape per provider, and omits `speech_models` / `model` entirely unless you set the matching env var, so a request never carries a model name your account may not have access to.

## Prerequisites

- Node.js 18 or newer (uses built-in `fetch`)
- A MeetStream API key from [app.meetstream.ai](https://app.meetstream.ai)
- A live meeting URL (Zoom, Google Meet, or Microsoft Teams)

## Setup

```bash
cp .env.example .env
```

Set `MEETSTREAM_API_KEY`, then pick a `PROVIDER`.

## Run

```bash
# default: Deepgram nova-3
node index.js https://meet.google.com/xxx-xxxx-xxx

# AssemblyAI with speaker labels
PROVIDER=assemblyai DIARIZE=true node index.js <meeting_link>

# Sarvam for a Hindi call
PROVIDER=sarvam LANGUAGE=hi-IN node index.js <meeting_link>

# JigsawStack: auto-detect the language and translate to English
PROVIDER=jigsawstack TRANSLATE=true node index.js <meeting_link>

# MeetStream in-house
PROVIDER=meetstream node index.js <meeting_link>
```

Output lands in `transcripts/<provider>-<transcript_id>.{json,txt}`, so comparison runs do not overwrite each other.

## How it works

1. **`POST /bots/create_bot`** with `recording_config.transcript.provider` set to the single-key block for your provider. The request carries an `Idempotency-Key` header, so a retry replays the original bot (HTTP 507) rather than creating and charging for a second one. `src/client.js` treats 507 as success.
2. **Keep `transcript_id` from the response.** `create_bot` returns `{ bot_id, transcript_id, meeting_url, status }`. That is the cheapest place to get the id - it is not in webhooks. The template falls back to `GET /bots/{id}/detail` then `GET /bots/{id}/transcriptions` if it is missing.
3. **Poll `GET /bots/{bot_id}/status`** until the bot reaches a terminal status. Polling keeps this template dependency-free; a `callback_url` webhook is the better production pattern (see `post-call-transcription`).
4. **`GET /transcript/{transcript_id}/get_transcript`**, retrying on HTTP 202 up to `MAX_POLL_ATTEMPTS`.
5. **Parse `speaker` + `transcript`** - not `text` - and merge consecutive segments from the same speaker into turns.

## Comparing providers fairly

Run each provider against the **same** meeting. Two runs of the same provider on two different calls tell you nothing about the provider.

Two options:

- Send several bots to one live meeting, one per provider, at the same time.
- Or run one bot, then use the `re-transcribe-audio` template to re-run the stored audio through each other provider. Same audio, different engines, no scheduling required - this is the cleaner comparison.

What to look at: proper nouns and product names, numbers and currency, punctuation and sentence boundaries, speaker attribution accuracy when diarization is on, and how each engine handles cross-talk.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MEETSTREAM_API_KEY` | - | Required. Sent as `Authorization: Token <key>`. |
| `MEETING_LINK` | - | Meeting to join. The first CLI argument overrides it. |
| `PROVIDER` | `deepgram` | `deepgram` \| `assemblyai` \| `sarvam` \| `jigsawstack` \| `meetstream`. |
| `LANGUAGE` | - | Language code in the provider's own format. |
| `DIARIZE` | `false` | Speaker labels where supported. |
| `TRANSLATE` | `false` | `jigsawstack` / `meetstream` only. |
| `DEEPGRAM_MODEL` | `nova-3` | Deepgram model override. |
| `ASSEMBLYAI_SPEECH_MODELS` | - | Comma-separated array; omitted when unset. |
| `SARVAM_MODEL` | - | Sarvam model override; omitted when unset. |
| `BOT_NAME` | `MeetStream Labs Bot` | Display name in the meeting. |
| `CALLBACK_URL` | - | Lifecycle webhook URL. |
| `RETENTION_HOURS` | `24` | `recording_config.retention.hours`. |
| `STATUS_POLL_INTERVAL_MS` / `MAX_STATUS_POLLS` | `15000` / `240` | How long to wait for the meeting to end. |
| `MAX_POLL_ATTEMPTS` / `POLL_INTERVAL_MS` | `36` / `5000` | HTTP 202 retry cap. |
| `OUTPUT_DIR` | `transcripts` | Where output is written. |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `HTTP 400` on `create_bot` | Two provider keys under `provider`, or AssemblyAI sent Deepgram's `model`/`language` instead of `speech_models`/`language_code`. |
| `"deepgram_streaming" is a streaming provider` | Correct. Streaming providers never produce a post-call transcript. Use `live-captions-overlay` instead. |
| Bot status goes to `NotAllowed` | The bot was never admitted from the waiting room. Nothing was recorded. |
| Bot status goes to `Denied` | The host refused the join request. |
| HTTP 202 until the retry cap | Transcription is still running, or the run failed. Check `GET /bots/{bot_id}/transcriptions` for the run status. |
| Transcript prints blank lines | You read `segment.text`. The field is `segment.transcript`. |
| Wrong language in the output | `LANGUAGE` must be in the provider's own format - `"en"` for Deepgram, `"en_us"` for AssemblyAI, `"hi-IN"` for Sarvam. See `multilingual-transcription`. |

## Related templates

- `multilingual-transcription` - language selection per provider in depth
- `re-transcribe-audio` - compare providers on identical audio
- `speaker-diarization` - per-speaker turns and talk-time stats
- `transcript-fetcher` - transcript retrieval on its own
