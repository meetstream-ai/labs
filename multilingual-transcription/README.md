# multilingual-transcription

Transcribe non-English meetings with MeetStream, using the right provider and the right language code format for that provider.

```bash
cp .env.example .env      # add MEETSTREAM_API_KEY
npm install
PROVIDER=sarvam LANGUAGE=ta-IN node index.js https://meet.google.com/xxx-xxxx-xxx
```

## What it does

Sends a bot with a language-configured transcription provider, waits for the meeting to end, then fetches and prints the transcript. Before the request goes out it checks your language code against the provider's expected format and warns about the common mix-ups.

```bash
node index.js --languages    # per-provider codes, no API key needed
```

## The core idea: there is no single language parameter

MeetStream passes provider options through to the upstream vendor. Each vendor names its language field differently and expects a different code format:

| Provider | Field | Format | Examples |
|---|---|---|---|
| `deepgram` | `language` | ISO 639-1, optional region with a **hyphen** | `en`, `en-US`, `es`, `fr`, `de`, `hi`, `ja`, `zh` |
| `assemblyai` | `language_code` | lowercase, region with an **underscore** | `en`, `en_us`, `en_uk`, `es`, `fr`, `de`, `hi` |
| `sarvam` | `language_code` | BCP-47 with the **`-IN`** region | `hi-IN`, `ta-IN`, `te-IN`, `kn-IN`, `ml-IN`, `bn-IN`, `mr-IN`, `gu-IN`, `pa-IN`, `od-IN`, `en-IN` |
| `jigsawstack` | `language` | `"auto"` to detect, or an ISO code | `auto`, `es`, `ja` |
| `meetstream` | `language` | `"auto"` to detect, or an ISO code | `auto`, `es`, `ja` |

These are common, useful codes rather than each vendor's complete supported list. Check the provider's own documentation for the full set.

Two ways this goes wrong, and they fail differently:

**Wrong field name.** Sending `language: "ta"` to AssemblyAI, which reads `language_code`, is not an error. The option is silently ignored, AssemblyAI falls back to its default, and you get a fluent, confident, completely wrong English transcription of a Tamil call. Nothing in the response tells you this happened.

**Wrong code format.** Sending `hi-IN` to Deepgram is usually an HTTP 400 - which is the better outcome, because it is loud.

The template's `src/languages.js` catches both classes before the request goes out, and warns rather than blocking so an unusual-but-valid code still gets through.

## Choosing a provider

**Indic languages - use `sarvam`.** Hindi, Tamil, Telugu, Kannada, Malayalam, Marathi, Bengali, Gujarati, Punjabi, Odia, and Indian-accented English. Sarvam is built and trained for these; the generalist engines are noticeably weaker on them, especially with code-switching between English and an Indic language mid-sentence, which is normal in Indian business meetings.

```bash
PROVIDER=sarvam LANGUAGE=hi-IN node index.js <meeting_link>
PROVIDER=sarvam LANGUAGE=ta-IN DIARIZE=true node index.js <meeting_link>
PROVIDER=sarvam LANGUAGE=en-IN node index.js <meeting_link>   # Indian-accented English
```

**European and East Asian languages - use `deepgram` or `assemblyai`.**

```bash
PROVIDER=deepgram   LANGUAGE=es    node index.js <meeting_link>   # Spanish
PROVIDER=deepgram   LANGUAGE=ja    node index.js <meeting_link>   # Japanese
PROVIDER=assemblyai LANGUAGE=de    node index.js <meeting_link>   # German
PROVIDER=assemblyai LANGUAGE=en_uk node index.js <meeting_link>   # UK English
```

**Unknown or mixed language - use `jigsawstack` or `meetstream` with `auto`.**

```bash
PROVIDER=jigsawstack node index.js <meeting_link>                    # detect
PROVIDER=jigsawstack TRANSLATE=true node index.js <meeting_link>     # detect + translate to English
PROVIDER=meetstream  TRANSLATE=true node index.js <meeting_link>
```

Only `jigsawstack` and `meetstream` support `translate`. Setting `TRANSLATE=true` on any other provider is a no-op and the template says so.

## Prerequisites

- Node.js 18 or newer (uses built-in `fetch`)
- A MeetStream API key from [app.meetstream.ai](https://app.meetstream.ai)
- A live meeting URL (Zoom, Google Meet, or Microsoft Teams)

## Setup

```bash
cp .env.example .env
```

Set `MEETSTREAM_API_KEY`, `PROVIDER`, and `LANGUAGE`.

## Run

```bash
node index.js <meeting_link>
node index.js --languages     # print the code catalogue and exit
```

Output is saved to `transcripts/<provider>-<language>-<transcript_id>.{json,txt}` as UTF-8, so non-Latin scripts survive the round trip.

## How it works

1. **Validate the language code** against the provider's format. Warnings only, never a hard block.
2. **`POST /bots/create_bot`** with the language in the correct field:
   ```json
   { "recording_config": { "transcript": {
       "provider": { "sarvam": { "language_code": "ta-IN" } } } } }
   ```
   Sent with an `Idempotency-Key`, so a retry replays the original bot (HTTP 507) instead of creating a duplicate.
3. **Poll `GET /bots/{bot_id}/status`** until the bot reaches a terminal status.
4. **Fetch `GET /transcript/{transcript_id}/get_transcript`**, retrying on HTTP 202 with a cap. The `transcript_id` comes from the `create_bot` response, falling back to `/detail` then `/transcriptions`.
5. **Parse `speaker` + `transcript`** - not `text` - and merge consecutive same-speaker segments into turns.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MEETSTREAM_API_KEY` | - | Required. Sent as `Authorization: Token <key>`. |
| `MEETING_LINK` | - | Meeting to join. The first CLI argument overrides it. |
| `PROVIDER` | `deepgram` | `deepgram` \| `assemblyai` \| `sarvam` \| `jigsawstack` \| `meetstream`. |
| `LANGUAGE` | - | Language code in the provider's own format. |
| `TRANSLATE` | `false` | `jigsawstack` / `meetstream` only. |
| `DIARIZE` | `false` | Speaker labels where supported. |
| `DEEPGRAM_MODEL` | `nova-3` | Deepgram model override. |
| `ASSEMBLYAI_SPEECH_MODELS` | - | Comma-separated array; omitted when unset. |
| `SARVAM_MODEL` / `SARVAM_MODE` | - | Sarvam overrides; omitted when unset. |
| `BOT_NAME` | `MeetStream Labs Bot` | Display name in the meeting. |
| `CALLBACK_URL` | - | Lifecycle webhook URL. |
| `RETENTION_HOURS` | `24` | `recording_config.retention.hours`. |
| `STATUS_POLL_INTERVAL_MS` / `MAX_STATUS_POLLS` | `15000` / `240` | How long to wait for the meeting to end. |
| `MAX_POLL_ATTEMPTS` / `POLL_INTERVAL_MS` | `36` / `5000` | HTTP 202 retry cap. |
| `OUTPUT_DIR` | `transcripts` | Where output is written. |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Transcript is fluent English but the call was not | The language option never reached the provider. Check the field name: AssemblyAI and Sarvam read `language_code`, Deepgram reads `language`. |
| `HTTP 400` on `create_bot` | Wrong code format for the provider. `hi-IN` is Sarvam, `hi` is Deepgram, `en_us` is AssemblyAI. Run `node index.js --languages`. |
| Indic transcript is poor quality | Switch to `sarvam` with the matching `xx-IN` code. The generalist engines are weak on Indic languages and on English/Indic code-switching. |
| `TRANSLATE=true` did nothing | Only `jigsawstack` and `meetstream` translate. |
| Non-Latin script shows as `???` | Your terminal is not UTF-8. The saved `.txt` and `.json` files are correct regardless. |
| Mixed-language meeting transcribes badly | Single-language providers commit to one language. Try `jigsawstack` with `auto`. |
| Empty transcript | Either nobody spoke, or the wrong language was configured and the provider matched nothing. |

## Related templates

- `multi-provider-transcription` - the full provider comparison
- `re-transcribe-audio` - retry a bad language guess without rejoining the meeting
- `speaker-diarization` - per-speaker turns and talk-time stats
- `transcript-fetcher` - transcript retrieval on its own
