# Extract Action Items from Meeting Transcripts with the MeetStream API

Send a MeetStream bot into a Zoom, Google Meet or Microsoft Teams meeting, fetch the post-call transcript, and run an LLM (OpenAI or Anthropic) over it to extract action items with owners and resolved due dates. Output is structured JSON plus a Markdown report. Any finished meeting can be replayed by `bot_id` or `transcript_id` without joining again.

```bash
npm install
cp .env.example .env    # fill in MEETSTREAM_API_KEY and OPENAI_API_KEY
node index.js --bot <bot_id>
```

## What it does

1. `POST /bots/create_bot` with your `meeting_link` and a `callback_url`.
2. Serves a webhook and follows the bot lifecycle to `transcription.processed`.
3. Fetches the transcript with `GET /transcript/{transcript_id}/get_transcript`.
4. Reads MeetStream's AI summary from `GET /bots/{bot_id}/summary` to give the model framing.
5. Sends the transcript to OpenAI or Anthropic with the meeting date and the speaker list, and asks for strict JSON.
6. Writes `output/action-items-<transcript_id>.json` and `output/action-items-<transcript_id>.md`.

Each action item comes back as:

```json
{
  "task": "Send the revised pricing sheet",
  "owner": "Priya",
  "due_raw": "before the board call on Thursday",
  "due_date": "2026-08-27",
  "priority": "high",
  "evidence": "I'll get the revised pricing over before the board call on Thursday."
}
```

The output also includes `decisions` and `open_questions`.

## Prerequisites

- Node 18 or newer.
- A MeetStream API key from <https://app.meetstream.ai>.
- An OpenAI or Anthropic API key. This template does not run without one.
- For live mode, a public HTTPS URL. In development:
  ```bash
  ngrok http 3000
  # or
  cloudflared tunnel --url http://localhost:3000
  ```

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/action-item-extractor
npm install
cp .env.example .env
node index.js --meeting "https://meet.google.com/abc-defg-hij"
```

Set `MEETSTREAM_API_KEY` and one of `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`. `LLM_PROVIDER` picks between them when both are present; leave it unset and whichever key exists wins.

Models are configurable: `OPENAI_MODEL` defaults to `gpt-4o-mini`, `ANTHROPIC_MODEL` defaults to `claude-sonnet-4-5`.

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>`. |
| `OPENAI_API_KEY` | one of | OpenAI key. Used when `LLM_PROVIDER=openai` or when it is the only LLM key set. |
| `ANTHROPIC_API_KEY` | one of | Anthropic key. Used when `LLM_PROVIDER=anthropic` or when it is the only LLM key set. |
| `LLM_PROVIDER` | no | `openai` or `anthropic`. Unset: whichever key exists wins. |
| `OPENAI_MODEL` | no | Default `gpt-4o-mini`. |
| `ANTHROPIC_MODEL` | no | Default `claude-sonnet-4-5`. |
| `LLM_MAX_TRANSCRIPT_CHARS` | no | Head-and-tail truncation cap for the prompt. Default `60000`. |
| `LLM_MAX_TOKENS` | no | Max completion tokens. Default `2500`. |
| `MEETING_LINK` | live mode | Zoom, Google Meet or Teams link. Same as `--meeting`. |
| `PUBLIC_BASE_URL` | live mode | Public HTTPS base; `callback_url` becomes `${PUBLIC_BASE_URL}/webhook`. Same as `--public-url`. |
| `PORT` | no | Webhook port. Default `3000`. Same as `--port`. |
| `BOT_NAME` | no | Display name in the meeting. Default `MeetStream Labs Bot`. |
| `BOT_ID` | replay | Replay a finished meeting. Same as `--bot`. |
| `TRANSCRIPT_ID` | replay | Replay a known transcript. Same as `--transcript`. |
| `TRANSCRIPT_PROVIDER` | no | Post-call provider: `deepgram`, `assemblyai`, `sarvam`, `jigsawstack` or `meetstream`. Default `meetstream`. Never a `*_streaming` provider. |
| `TRANSCRIPT_LANGUAGE` | no | Language code passed to the provider. Default `en`. |
| `TRANSCRIPT_POLL_ATTEMPTS` | no | Cap on `get_transcript` polls while the API answers 202. Default `20`. |
| `TRANSCRIPT_POLL_INTERVAL_MS` | no | Delay between transcript polls. Default `5000`. |
| `RETENTION_HOURS` | no | `recording_config.retention.hours` on create. Only sent when set; the API default is 720 hours (30 days). |
| `MEETING_DATE` | no | `YYYY-MM-DD` the relative due dates are resolved against. Default today. Set it when replaying an older meeting. |
| `OUTPUT_DIR` | no | Where the JSON and Markdown are written. Default `output`. |
| `PRINT_MARKDOWN` | no | `false` to skip printing the report to stdout. Default `true`. |
| `MEETSTREAM_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |

## Run

```bash
node index.js --meeting "https://meet.google.com/abc-defg-hij"   # live
node index.js --bot 8f2c1a3e-...                                  # replay
node index.js --transcript 4b71d0ca-...                           # replay
```

When replaying an older meeting, set `MEETING_DATE=2026-08-20` so phrases like "by Friday" resolve to the right calendar date instead of being anchored on today.

## How it works

```
index.js          orchestration for this template
src/pipeline.js   create the bot, serve the webhook, fetch the transcript
src/meetstream.js the MeetStream API client
src/llm.js        pluggable OpenAI / Anthropic client, tolerant JSON parsing
src/extract.js    the extraction prompt and response normalisation
src/render.js     Markdown report and file output
```

Prompt design notes:

- The model gets the speaker list and every `owner` it returns is snapped back to a real speaker name where possible, so owners are people who were actually in the room.
- It gets the meeting date and its weekday, which is what makes relative due dates resolvable.
- `due_raw` keeps the phrase the speakers used, `due_date` is the resolved ISO date. Anything not matching `YYYY-MM-DD` is discarded rather than passed through.
- OpenAI runs in JSON mode. Anthropic gets the same instruction in the system prompt, and the parser tolerates code fences either way.
- Long transcripts are truncated head-and-tail to stay inside `LLM_MAX_TRANSCRIPT_CHARS`, with a marker showing what was cut.

The MeetStream details that matter:

- Auth is `Authorization: Token <key>`. The literal word `Token`, not `Bearer`.
- The create field is `meeting_link`, not `meeting_url`.
- Every webhook carries `event`; most also carry `bot_event` with the specific name. We act on `transcription.processed`, and treat `bot.done` (the final event on every path) arriving without it as "no post-call transcript".
- Every ending arrives as `event: "bot.stopped"`, with the reason in `bot_event`: `bot.stopped` (200), `bot.kicked` (200), `bot.notallowed` (500), `bot.denied` (500), `bot.failed` (usually 500). Branch on `bot_event`; fall back to `bot_status` case-insensitively only when it is missing, since a kick and a clean exit both report `Stopped`.
- Webhooks never include `transcript_id`. It comes from `create_bot`, `GET /bots/{id}/detail`, or `GET /bots/{id}/transcriptions`.
- The transcript is fetched by **transcript_id**, not bot_id, and segments carry text in a field named `transcript`, not `text`.
- `HTTP 202` means "still processing, poll again". Polling is capped.
- `HTTP 507` is an idempotent replay and is treated as success.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Missing required environment variable: MEETSTREAM_API_KEY` | No `.env`, or an empty key. | `cp .env.example .env` and paste your key. |
| `This template needs an LLM` | Neither `OPENAI_API_KEY` nor `ANTHROPIC_API_KEY` is set. | Set one of them. |
| HTTP 401 / 403 | No key was sent, or the key is wrong or inactive. | Check `.env` is loaded from the directory you ran `node` in; generate a new key at <https://app.meetstream.ai>. |
| HTTP 404 on `/bots/{id}/detail` | Wrong `bot_id`, or the recording expired via its retention window. | Confirm the id against the bot list in the dashboard. |
| `PUBLIC_BASE_URL is required in live mode` | No tunnel URL. | Start `ngrok http 3000` and set `PUBLIC_BASE_URL` to the https URL. |
| `get_transcript` still 202 after the poll cap | The bot used a streaming-only provider (`deepgram_streaming`, `assemblyai_streaming`, `jigsawstack_streaming`, `meetstream_streaming`, `meeting_captions`); those never write a post-call transcript. | Use a post-call provider: `meetstream` or `deepgram`. |
| `No transcript_id found for bot` | Same cause: streaming-only provider returns `transcript_id: null`. | Re-run the meeting with a post-call provider. |
| Bot stopped with `bot.notallowed` / `bot.denied` / `bot.failed` | Waiting-room timeout, host refused entry, or the bot crashed. | Admit the bot faster, ask the host to allow it, or check the bot's status in the dashboard. |
| HTTP 507 on create | Idempotent replay of an earlier `create_bot` with the same `Idempotency-Key`. | Nothing to fix; the existing bot is reused. |
| `Could not parse JSON from the LLM response` | Small models sometimes wrap JSON in prose. The parser strips code fences and hunts for the outermost object. | Switch to a stronger model via `OPENAI_MODEL` or `ANTHROPIC_MODEL`. |
| Owners come back as `null` | The transcript has generic speaker labels rather than names; diarisation quality drives this. | Try `TRANSCRIPT_PROVIDER=deepgram`, which is configured here with `diarize: true`. |
| Due dates are wrong when replaying an old meeting | The model anchored on today. | Set `MEETING_DATE` to the actual meeting date. |
| Empty action items on a meeting that clearly had some | The transcript is near-empty: the bot recorded silence or joined the wrong meeting. | Check the segment count the console prints. |
| OpenAI / Anthropic 429 | Rate limited or out of credit. The LLM call is deliberately not retried so you see the failure straight away. | Wait, or top up the account. The MeetStream client does retry transient 429/500/503. |

## Related

- [Post-call transcription](https://docs.meetstream.ai/guides/transcription-recordings/post-call-transcription)
- [Transcription providers](https://docs.meetstream.ai/guides/transcription-recordings/providers/transcription-providers)
- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Get transcription](https://docs.meetstream.ai/api-reference/api-endpoints/transcription/get-transcription)
- [Get bot summary](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-summary)
- [Create bot payload reference](https://docs.meetstream.ai/api-reference/create-bot-payload-reference)
- [Error codes](https://docs.meetstream.ai/errors)
- Sibling templates: [ai-meeting-summary](../ai-meeting-summary), [transcript-fetcher](../transcript-fetcher), [speaker-diarization](../speaker-diarization)
