# Compare Five Post-Call Transcription Providers with the MeetStream API

Send a MeetStream meeting bot into a Zoom, Google Meet or Microsoft Teams meeting and transcribe the recording with any of the five post-call transcription providers (Deepgram, AssemblyAI, Sarvam, JigsawStack, MeetStream), switched with a single environment variable. Run it again with a different `PROVIDER` on the same meeting for a side-by-side comparison.

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
git clone https://github.com/meetstream-ai/labs.git
cd labs/multi-provider-transcription
npm install
cp .env.example .env      # set MEETSTREAM_API_KEY, then pick a PROVIDER
node index.js https://meet.google.com/xxx-xxxx-xxx
```

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>`. |
| `MEETING_LINK` | one of | Meeting to join. The first CLI argument overrides it. |
| `PROVIDER` | no | `deepgram`, `assemblyai`, `sarvam`, `jigsawstack` or `meetstream`. Default `deepgram`. Never a `*_streaming` provider. |
| `LANGUAGE` | no | Language code in the provider's own format (`en`, `en_us`, `hi-IN`, `auto`). Unset: provider default. |
| `DIARIZE` | no | `true` requests speaker labels where supported. Default `false`. |
| `TRANSLATE` | no | `jigsawstack` / `meetstream` only: translate to English. Default `false`. |
| `DEEPGRAM_MODEL` | no | Deepgram model. Default `nova-3`. |
| `ASSEMBLYAI_SPEECH_MODELS` | no | Comma-separated list; sent as the `speech_models` array, omitted when unset. |
| `SARVAM_MODEL` | no | Sarvam model; omitted when unset. |
| `BOT_NAME` | no | Display name in the meeting. Default `MeetStream Labs Bot`. |
| `CALLBACK_URL` | no | Lifecycle webhook URL. |
| `RETENTION_HOURS` | no | `recording_config.retention.hours`. Default `24` here; the API default when omitted is 720. |
| `STATUS_POLL_INTERVAL_MS` | no | Delay between `GET /bots/{id}/status` polls. Default `15000`. |
| `MAX_STATUS_POLLS` | no | Status poll cap. Default `240` (60 minutes with the default interval). |
| `MAX_POLL_ATTEMPTS` | no | Cap on `get_transcript` polls while the API answers 202. Default `36`. |
| `POLL_INTERVAL_MS` | no | Delay between transcript polls. Default `5000`. |
| `OUTPUT_DIR` | no | Where `.json` and `.txt` outputs are written. Default `transcripts`. |
| `MEETSTREAM_API_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |

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
3. **Poll `GET /bots/{bot_id}/status`** until the bot reaches a terminal status. Polling keeps this template dependency-free; a `callback_url` webhook is the better production pattern (see [post-call-transcription](../post-call-transcription)).
4. **`GET /transcript/{transcript_id}/get_transcript`**, retrying on HTTP 202 up to `MAX_POLL_ATTEMPTS`.
5. **Parse `speaker` + `transcript`** - not `text` - and merge consecutive segments from the same speaker into turns.

## Comparing providers fairly

Run each provider against the **same** meeting. Two runs of the same provider on two different calls tell you nothing about the provider.

Two options:

- Send several bots to one live meeting, one per provider, at the same time.
- Or run one bot, then use the [re-transcribe-audio](../re-transcribe-audio) template to re-run the stored audio through each other provider. Same audio, different engines, no scheduling required - this is the cleaner comparison.

What to look at: proper nouns and product names, numbers and currency, punctuation and sentence boundaries, speaker attribution accuracy when diarization is on, and how each engine handles cross-talk.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `MEETSTREAM_API_KEY is not set` | No `.env`, or an empty key. | `cp .env.example .env` and paste your key. |
| HTTP 401 / 403 | No key was sent, or the key was rejected. | The header is `Authorization: Token <key>`; regenerate the key if 403 persists. |
| `HTTP 400` on `create_bot` | Two provider keys under `provider`, or AssemblyAI sent Deepgram's `model`/`language` instead of `speech_models`/`language_code`. | Check the provider block the template prints before the call. |
| `"deepgram_streaming" is a streaming provider` | Correct. Streaming providers never produce a post-call transcript. | Use [live-captions-overlay](../live-captions-overlay) instead. |
| HTTP 404 on `get_transcript` | Wrong `transcript_id`, or the recording expired via its retention window. | Re-run; `RETENTION_HOURS` defaults to 24 here. |
| Bot status goes to `NotAllowed` | The bot was never admitted from the waiting room. Nothing was recorded. | Admit it faster, or raise `automatic_leave.waiting_room_timeout`. |
| Bot status goes to `Denied` | The host refused the join request. | Ask the host to admit the bot. |
| HTTP 202 until the retry cap | Transcription is still running, or the run failed. | Check `GET /bots/{bot_id}/transcriptions` for the run status; raise `MAX_POLL_ATTEMPTS` for long meetings. |
| Transcript prints blank lines | You read `segment.text`. | The field is `segment.transcript`. |
| Wrong language in the output | `LANGUAGE` must be in the provider's own format: `"en"` for Deepgram, `"en_us"` for AssemblyAI, `"hi-IN"` for Sarvam. | See [multilingual-transcription](../multilingual-transcription). |

## Related

- [Transcription providers](https://docs.meetstream.ai/guides/transcription-recordings/providers/transcription-providers)
- [Deepgram](https://docs.meetstream.ai/guides/transcription-recordings/providers/deepgram), [AssemblyAI](https://docs.meetstream.ai/guides/transcription-recordings/providers/assemblyai), [Sarvam](https://docs.meetstream.ai/guides/transcription-recordings/providers/sarvam), [JigsawStack](https://docs.meetstream.ai/guides/transcription-recordings/providers/jigsawstack), [MeetStream](https://docs.meetstream.ai/guides/transcription-recordings/providers/meetstream)
- [Post-call transcription](https://docs.meetstream.ai/guides/transcription-recordings/post-call-transcription)
- [Languages and translation](https://docs.meetstream.ai/guides/transcription-recordings/languages-and-translation)
- [Get transcription](https://docs.meetstream.ai/api-reference/api-endpoints/transcription/get-transcription)
- [Get bot transcriptions](https://docs.meetstream.ai/api-reference/api-endpoints/transcription/get-bot-transcriptions)
- Sibling templates: [multilingual-transcription](../multilingual-transcription) covers language selection per provider in depth; [re-transcribe-audio](../re-transcribe-audio) compares providers on identical audio; [speaker-diarization](../speaker-diarization) gives per-speaker turns and talk-time stats; [transcript-fetcher](../transcript-fetcher) is transcript retrieval on its own.
