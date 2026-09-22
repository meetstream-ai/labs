# Re-transcribe Meeting Audio with a Different Provider Using the MeetStream API

Re-run transcription on a MeetStream meeting bot that has already finished a Zoom, Google Meet or Microsoft Teams call, with a different provider, model or language, via `POST /bots/{bot_id}/transcribe`. The stored recording is untouched and every run gets its own `transcript_id`.

## Prerequisites

- Node.js 18 or newer (uses built-in `fetch`)
- A MeetStream API key from [app.meetstream.ai](https://app.meetstream.ai)
- A bot that has finished and has stored audio (past `audio.processed`, and inside its retention window, 30 days by default)

## What it does

```
POST /bots/{bot_id}/transcribe
{ "provider": { "deepgram": { "model": "nova-3", "language": "en" } },
  "callback_url": "https://your-server.example.com/webhook" }
```

MeetStream transcribes the bot's stored audio again. The recording is untouched and the earlier transcript is not overwritten: **each run produces its own `transcript_id`**, and `GET /bots/{bot_id}/transcriptions` lists every one of them. That makes it safe to try a second provider and compare before committing.

This template triggers the run, works out which `transcript_id` is the new one, polls until the transcript is ready (capped), then prints and saves it.

## When you need it

**The provider failed.** You received `transcription.failed` (`status_code: 500`), or a run shows `status: "Failed"` in `/transcriptions`. The audio is fine, only the transcription step broke. Re-run it, optionally against a different provider so you are not retrying the same failure.

**Wrong language, or the wrong provider for the language.** A meeting that ran mostly in Hindi transcribed with `deepgram` + `language: "en"` produces confident nonsense. Re-run with `sarvam` and `language_code: "hi-IN"`. Nothing about the original bot needs to change.

**You want better quality.** The first pass used a fast, cheap provider. For the calls that turn out to matter, re-run with a higher-quality model, or with diarization enabled so you get speaker attribution you did not ask for the first time.

**A streaming-only bot needs a post-call transcript.** This is the big one. A bot created with `deepgram_streaming` (or any `*_streaming` provider) delivers transcripts live over your webhook and **never produces a post-call transcript**: `GET /transcript/{id}/get_transcript` returns HTTP 202 forever, and its lifecycle never includes `transcription.processed` (it still ends with `bot.done`, like every bot). If your live consumer dropped chunks, crashed mid-meeting, or you simply want a durable record afterwards, `POST /bots/{id}/transcribe` with a post-call provider is how you get one. The audio was recorded either way.

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/re-transcribe-audio
npm install
cp .env.example .env      # add MEETSTREAM_API_KEY
node index.js <bot_id>
```

Pick a `PROVIDER` and `LANGUAGE` in `.env` if the defaults are not what you want.

## Run

```bash
node index.js <bot_id>

# a different provider
PROVIDER=assemblyai node index.js <bot_id>

# Hindi, via Sarvam, with speaker labels
PROVIDER=sarvam LANGUAGE=hi-IN DIARIZE=true node index.js <bot_id>

# rescue a streaming-only bot
PROVIDER=deepgram node index.js <bot_id>

# fire and forget, let the webhook tell you
CALLBACK_URL=https://your-server.example.com/webhook \
WAIT_FOR_TRANSCRIPT=false node index.js <bot_id>
```

## What you should see

With the defaults, a successful run prints roughly this (ids shortened):

```
Bot      : <bot_id>
Provider : deepgram
Config   : {"model":"nova-3"}

Existing transcription runs (1):
  <transcript_id_1>  provider=deepgram_streaming  status=Success  created=2026-09-18T10:02:11Z

POST /bots/<bot_id>/transcribe
Accepted.

New transcript_id: <transcript_id_2>
  provider=deepgram  status=Processing

GET /transcript/<transcript_id_2>/get_transcript?raw=false
  HTTP 202 - transcription still running (1/36)...
  HTTP 202 - transcription still running (2/36)...

42 segment(s) → 9 speaker turn(s)

------------------------------------------------------------------------------

[00:12] Alice
    Can you walk me through the roadmap?

[00:15] Bob
    Sure, there are three tiers ...

------------------------------------------------------------------------------

Saved JSON → transcripts/<transcript_id_2>.json
Saved text → transcripts/<transcript_id_2>.txt
```

Two files land in `OUTPUT_DIR` (default `transcripts/`): `<transcript_id>.json` is the raw API response, and `<transcript_id>.txt` is the readable speaker-turn version with a short header.

With `WAIT_FOR_TRANSCRIPT=false` the run stops after `New transcript_id: ...` and prints `WAIT_FOR_TRANSCRIPT=false - not polling.` plus a `transcript-fetcher` command you can use later.

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>`. |
| `BOT_ID` | yes (or CLI arg) | Bot to re-transcribe. The first CLI argument overrides it. |
| `PROVIDER` | no | Post-call provider: `deepgram`, `assemblyai`, `sarvam`, `jigsawstack` or `meetstream`. Default `deepgram`. |
| `LANGUAGE` | no | Language code in the provider's own format. Unset means the provider default. |
| `DIARIZE` | no | `true` requests speaker labels where supported. Default `false`. |
| `TRANSLATE` | no | `jigsawstack` / `meetstream` only: translate the output. Default `false`. |
| `DEEPGRAM_MODEL` | no | Deepgram model override. Default `nova-3`. |
| `ASSEMBLYAI_SPEECH_MODELS` | no | Comma-separated `speech_models`; omitted from the request when unset. |
| `SARVAM_MODEL` | no | Sarvam model override; omitted when unset. |
| `CALLBACK_URL` | no | Webhook for `transcription.processed` / `transcription.failed`. |
| `WAIT_FOR_TRANSCRIPT` | no | Poll for the result after triggering. Default `true`. |
| `MAX_POLL_ATTEMPTS` | no | Hard cap on 202 retries. Default `36`. |
| `POLL_INTERVAL_MS` | no | Delay between retries. Default `5000`. |
| `OUTPUT_DIR` | no | Where the `.json` and `.txt` outputs are written. Default `transcripts`. |
| `MEETSTREAM_API_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |

## Providers

`PROVIDER` accepts post-call providers only. Streaming providers are rejected up front with an explanation rather than an HTTP 400.

| Provider | Language field | Diarization field | Notes |
|---|---|---|---|
| `deepgram` | `language`, e.g. `"en"` | `diarize` | Default. `model` defaults to `nova-3`. |
| `assemblyai` | `language_code`, e.g. `"en_us"` | `speaker_labels` | Uses `speech_models` (an **array**), not `model`. |
| `sarvam` | `language_code`, e.g. `"hi-IN"` | `with_diarization` | Best for Indic languages. |
| `jigsawstack` | `language`, e.g. `"auto"` | `by_speaker` | Supports `translate`. |
| `meetstream` | `language`, e.g. `"auto"` | - | In-house. Supports `translate`. |

Set exactly one provider. The template builds the single-key `provider` object for you.

## How it works

1. **List existing runs**: `GET /bots/{bot_id}/transcriptions`, so you can see what is already there and so the new run is identifiable.
2. **Trigger**: `POST /bots/{bot_id}/transcribe` with the provider block.
3. **Find the new `transcript_id`**: from the response if it is there, otherwise by polling `/transcriptions` for an id that was not in the pre-run snapshot. This is why step 1 matters: a bot can have several transcripts and "the newest one" is only meaningful relative to what existed before.
4. **Poll the transcript**: `GET /transcript/{transcript_id}/get_transcript`, retrying on HTTP 202 up to `MAX_POLL_ATTEMPTS`.
5. **Parse and save**: segments use `speaker` + `transcript` (not `text`), written to `transcripts/`.

With `CALLBACK_URL` set, MeetStream also POSTs `transcription.processed` or `transcription.failed` to that URL when the run finishes, which is the right pattern in production. Set `WAIT_FOR_TRANSCRIPT=false` to skip the polling loop and rely on the webhook. `transcript_id` is never in a webhook payload, so keep the id this template prints.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `MEETSTREAM_API_KEY is not set` | No `.env` or empty key. | `cp .env.example .env` and paste your key. |
| `HTTP 401` / `HTTP 403` | No key sent, or the key was rejected. | Check the key is complete and active for this workspace. |
| `"deepgram_streaming" is not a post-call provider` | Streaming providers cannot re-transcribe a stored recording. | Use the post-call equivalent, `deepgram`. |
| `HTTP 404` on `/transcribe` | Wrong `bot_id`, the bot has no stored audio yet, or the audio was deleted (`DELETE /bots/{id}/delete` or retention expiry). | Wait for `audio.processed`; if the data is gone there is nothing to re-transcribe. |
| `HTTP 400` | The provider config is wrong, most often Deepgram-style `model`/`language` sent to AssemblyAI, which wants `speech_models`/`language_code`. | Match the field names in the Providers table. |
| No new `transcript_id` appeared | The run was accepted but `/transcriptions` has not listed it yet. | Check `GET /bots/{bot_id}/transcriptions` directly. |
| Polling hits the cap (HTTP 202) | The run is still going, or the provider failed. | Check the run's `status` in `/transcriptions`; raise `MAX_POLL_ATTEMPTS` for long recordings. |
| New transcript looks identical | You re-ran the same provider with the same config. | Change `PROVIDER` or `LANGUAGE`. |

## Related

- [Transcribe bot audio](https://docs.meetstream.ai/api-reference/api-endpoints/transcription/transcribe-bot-audio)
- [Get bot transcriptions](https://docs.meetstream.ai/api-reference/api-endpoints/transcription/get-bot-transcriptions)
- [Get transcription](https://docs.meetstream.ai/api-reference/api-endpoints/transcription/get-transcription)
- [Transcription providers](https://docs.meetstream.ai/guides/transcription-recordings/providers/transcription-providers)
- [Languages and translation](https://docs.meetstream.ai/guides/transcription-recordings/languages-and-translation)
- [Diarization](https://docs.meetstream.ai/guides/transcription-recordings/diarization)
- [Error reference](https://docs.meetstream.ai/errors)
- Templates: [transcript-fetcher](../transcript-fetcher/README.md) resolves a `transcript_id` and fetches a transcript; [multi-provider-transcription](../multi-provider-transcription/README.md) compares providers on a new bot; [multilingual-transcription](../multilingual-transcription/README.md) covers language selection per provider; [live-captions-overlay](../live-captions-overlay/README.md) is the streaming path this template rescues.
