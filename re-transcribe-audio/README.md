# re-transcribe-audio

Re-run transcription on a MeetStream bot that has already finished, with a different provider, model, or language.

```bash
cp .env.example .env      # add MEETSTREAM_API_KEY
npm install
node index.js <bot_id>
```

## What it does

```
POST /bots/{bot_id}/transcribe
{ "provider": { "deepgram": { "model": "nova-3", "language": "en" } },
  "callback_url": "https://your-server.example.com/webhook" }
```

MeetStream transcribes the bot's stored audio again. The recording is untouched and the earlier transcript is not overwritten: **each run produces its own `transcript_id`**, and `GET /bots/{bot_id}/transcriptions` lists every one of them. That makes it safe to try a second provider and compare before committing.

This template triggers the run, works out which `transcript_id` is the new one, polls until the transcript is ready, then prints and saves it.

## When you need it

**The provider failed.** You received `transcription.failed` (`status_code: 500`), or a run shows `status: "Failed"` in `/transcriptions`. The audio is fine - only the transcription step broke. Re-run it, optionally against a different provider so you are not retrying the same failure.

**Wrong language, or the wrong provider for the language.** A meeting that ran mostly in Hindi transcribed with `deepgram` + `language: "en"` produces confident nonsense. Re-run with `sarvam` and `language_code: "hi-IN"`. Nothing about the original bot needs to change.

**You want better quality.** The first pass used a fast, cheap provider. For the calls that turn out to matter, re-run with a higher-quality model, or with diarization enabled so you get speaker attribution you did not ask for the first time.

**A streaming-only bot needs a post-call transcript.** This is the big one. A bot created with `deepgram_streaming` (or any `*_streaming` provider) delivers transcripts live over your webhook and **never produces a post-call transcript** - `GET /transcript/{id}/get_transcript` returns HTTP 202 forever, and the lifecycle ends at `audio.processed` with no `transcription.processed` and no `bot.done`. If your live consumer dropped chunks, crashed mid-meeting, or you simply want a durable record afterwards, `POST /bots/{id}/transcribe` with a post-call provider is how you get one. The audio was recorded either way.

## Prerequisites

- Node.js 18 or newer (uses built-in `fetch`)
- A MeetStream API key from [app.meetstream.ai](https://app.meetstream.ai)
- A bot that has finished and has stored audio (past `audio.processed`)

## Setup

```bash
cp .env.example .env
```

Set `MEETSTREAM_API_KEY`. Pick a `PROVIDER` and `LANGUAGE` if the defaults are not what you want.

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

## Providers

`PROVIDER` accepts post-call providers only. Streaming providers are rejected up front with an explanation rather than an HTTP 400.

| Provider | Language field | Diarization field | Notes |
|---|---|---|---|
| `deepgram` | `language` - `"en"` | `diarize` | Default. `model` defaults to `nova-3`. |
| `assemblyai` | `language_code` - `"en_us"` | `speaker_labels` | Uses `speech_models` (an **array**), not `model`. |
| `sarvam` | `language_code` - `"hi-IN"` | `with_diarization` | Best for Indic languages. |
| `jigsawstack` | `language` - `"auto"` | `by_speaker` | Supports `translate`. |
| `meetstream` | `language` - `"auto"` | - | In-house. Supports `translate`. |

Set exactly one provider. The template builds the single-key `provider` object for you.

## How it works

1. **List existing runs** - `GET /bots/{bot_id}/transcriptions`, so you can see what is already there and so the new run is identifiable.
2. **Trigger** - `POST /bots/{bot_id}/transcribe` with the provider block.
3. **Find the new `transcript_id`** - from the response if it is there, otherwise by polling `/transcriptions` for an id that was not in the pre-run snapshot. This is why step 1 matters: a bot can have several transcripts and "the newest one" is only meaningful relative to what existed before.
4. **Poll the transcript** - `GET /transcript/{transcript_id}/get_transcript`, retrying on HTTP 202 up to `MAX_POLL_ATTEMPTS`.
5. **Parse and save** - segments use `speaker` + `transcript` (not `text`), written to `transcripts/`.

With `CALLBACK_URL` set, MeetStream also POSTs `transcription.processed` or `transcription.failed` to that URL when the run finishes, which is the right pattern in production. Set `WAIT_FOR_TRANSCRIPT=false` to skip the polling loop and rely on the webhook.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MEETSTREAM_API_KEY` | - | Required. Sent as `Authorization: Token <key>`. |
| `BOT_ID` | - | Bot to re-transcribe. The first CLI argument overrides it. |
| `PROVIDER` | `deepgram` | Post-call provider to run. |
| `LANGUAGE` | - | Language code in the provider's own format. |
| `DIARIZE` | `false` | Request speaker labels where supported. |
| `TRANSLATE` | `false` | `jigsawstack` / `meetstream` only. |
| `DEEPGRAM_MODEL` | `nova-3` | Deepgram model override. |
| `ASSEMBLYAI_SPEECH_MODELS` | - | Comma-separated; omitted from the request when unset. |
| `SARVAM_MODEL` | - | Sarvam model override; omitted when unset. |
| `CALLBACK_URL` | - | Webhook for `transcription.processed` / `transcription.failed`. |
| `WAIT_FOR_TRANSCRIPT` | `true` | Poll for the result after triggering. |
| `MAX_POLL_ATTEMPTS` | `36` | Hard cap on 202 retries. |
| `POLL_INTERVAL_MS` | `5000` | Delay between retries. |
| `OUTPUT_DIR` | `transcripts` | Where output is written. |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `"deepgram_streaming" is not a post-call provider` | Correct - streaming providers cannot re-transcribe a stored recording. Use the post-call equivalent, `deepgram`. |
| `HTTP 404` on `/transcribe` | Wrong `bot_id`, or the bot has no stored audio yet. Wait for `audio.processed`. |
| `HTTP 400` | The provider config is wrong. The most common cause is sending Deepgram-style `model`/`language` to AssemblyAI, which wants `speech_models`/`language_code`. |
| Polling hits the cap | The run is still going, or the provider failed. Check `GET /bots/{bot_id}/transcriptions` for the run's `status`. |
| New transcript looks identical | You re-ran the same provider with the same config. Change `PROVIDER` or `LANGUAGE`. |
| Data was already deleted | `DELETE /bots/{id}/delete` and expired retention windows remove the audio. There is nothing left to re-transcribe. |

## Related templates

- `transcript-fetcher` - resolve a `transcript_id` and fetch a transcript
- `multi-provider-transcription` - compare providers on a new bot
- `multilingual-transcription` - language selection per provider
- `live-captions-overlay` - the streaming path this template rescues
