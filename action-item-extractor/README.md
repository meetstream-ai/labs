# Action Item Extractor

Pulls a MeetStream transcript, runs an LLM over it to extract action items with owners and due dates, and writes structured JSON plus a Markdown report.

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
npm install
cp .env.example .env
```

Set `MEETSTREAM_API_KEY` and one of `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`. `LLM_PROVIDER` picks between them when both are present; leave it unset and whichever key exists wins.

Models are configurable: `OPENAI_MODEL` defaults to `gpt-4o-mini`, `ANTHROPIC_MODEL` defaults to `claude-sonnet-4-5`.

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
- The webhook envelope key is `event`. We act on `transcription.processed`.
- `bot.stopped` is always `status_code: 200`. Read `bot_status` for the reason: `Stopped`, `NotAllowed`, `Denied`, `Error`.
- Webhooks never include `transcript_id`. It comes from `create_bot`, `GET /bots/{id}/detail`, or `GET /bots/{id}/transcriptions`.
- The transcript is fetched by **transcript_id**, not bot_id, and segments carry text in a field named `transcript`, not `text`.
- `HTTP 202` means "still processing, poll again". Polling is capped.
- `HTTP 507` is an idempotent replay and is treated as success.

## Troubleshooting

**"Could not parse JSON from the LLM response".**
Small models sometimes wrap JSON in prose. The parser strips code fences and hunts for the outermost object, so if it still fails, switch to a stronger model via `OPENAI_MODEL` or `ANTHROPIC_MODEL`.

**Owners come back as null.**
The transcript has generic speaker labels rather than names. Diarisation quality drives this. Try `TRANSCRIPT_PROVIDER=deepgram`, which is configured here with `diarize: true`.

**Due dates are wrong when replaying an old meeting.**
Set `MEETING_DATE` to the actual meeting date. Without it the model anchors on today.

**Empty action items on a meeting that clearly had some.**
Check that the transcript actually has content. The console prints the segment count. A near-empty transcript usually means the bot recorded silence or joined the wrong meeting.

**`get_transcript` returns 202 until the retry cap.**
The bot used a streaming-only provider. `deepgram_streaming`, `assemblyai_streaming`, `jigsawstack_streaming`, `meetstream_streaming` and `meeting_captions` never write a post-call transcript. Use `meetstream` or `deepgram`.

**OpenAI 429.**
Rate limited or out of credit. The MeetStream client retries transient statuses, the LLM call does not, deliberately, so you see the failure straight away.
