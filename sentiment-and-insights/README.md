# Sentiment and Insights

Analyses a MeetStream transcript for sentiment trends, topics and talk-time balance, and produces a coaching-style report as Markdown plus JSON.

```bash
npm install
cp .env.example .env    # fill in MEETSTREAM_API_KEY and OPENAI_API_KEY
node index.js --bot <bot_id>
```

## What it does

1. `POST /bots/create_bot` with your `meeting_link` and a `callback_url`.
2. Serves a webhook and follows the bot lifecycle to `transcription.processed`.
3. Fetches the transcript with `GET /transcript/{transcript_id}/get_transcript`.
4. Pulls measured speaking time from `GET /bots/{bot_id}/get_speaker_timeline`.
5. Reads MeetStream's AI summary from `GET /bots/{bot_id}/summary` as framing.
6. Splits the transcript into chronological sections and asks an LLM how sentiment moved, what was discussed, what the risks were, and what to do differently.
7. Writes `output/insights-<transcript_id>.json` and `output/insights-<transcript_id>.md`.

The report contains:

- Overall sentiment with a rationale.
- Sentiment per section, so you can see where a call turned.
- Talk-time table and bar chart, plus a balance score.
- Per-speaker sentiment, engagement and one specific observation.
- Topics with airtime and sentiment.
- Risks and friction raised in the meeting.
- Numbered coaching points.

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

`TRANSCRIPT_PROVIDER` defaults to `deepgram` here, configured with `diarize: true`, because clean per-speaker attribution is what makes the talk-time numbers worth reading.

## Run

```bash
node index.js --meeting "https://meet.google.com/abc-defg-hij"   # live
node index.js --bot 8f2c1a3e-...                                  # replay
node index.js --transcript 4b71d0ca-...                           # replay
```

Pass `--bot` rather than `--transcript` when you can. The speaker timeline is fetched per bot, so a bot ID gets you measured talk time instead of an estimate.

## Talk time: measured or estimated

The report always states which source it used, in this order:

1. **`get_speaker_timeline`** - real measured speaking intervals. This is what you want, and it needs a `bot_id`.
2. **Transcript segment timings** - used when the timeline is unavailable but the transcript segments carry `start_time` and `end_time`.
3. **Word-count estimate at 150 wpm** - the last resort, and labelled as an estimate in the report so nobody mistakes it for a measurement.

The balance score is normalised entropy over the speaking shares: 100% means everyone spoke equally, and it stays comparable across meetings with different numbers of people.

## How it works

```
index.js          orchestration for this template
src/pipeline.js   create the bot, serve the webhook, fetch the transcript
src/meetstream.js the MeetStream API client
src/talktime.js   speaker timeline, talk-time stats, balance score
src/analyze.js    the sentiment and coaching prompt, response normalisation
src/report.js     Markdown report, ASCII charts, file output
src/llm.js        pluggable OpenAI / Anthropic client
```

The MeetStream details that matter:

- Auth is `Authorization: Token <key>`. The literal word `Token`, not `Bearer`.
- The create field is `meeting_link`, not `meeting_url`.
- The webhook envelope key is `event`. We act on `transcription.processed`.
- `bot.stopped` is always `status_code: 200`. Read `bot_status` for the reason: `Stopped`, `NotAllowed`, `Denied`, `Error`.
- Webhooks never include `transcript_id`. It comes from `create_bot`, `GET /bots/{id}/detail`, or `GET /bots/{id}/transcriptions`.
- The transcript is fetched by **transcript_id**, not bot_id, and segments carry text in a field named `transcript`, not `text`.
- `HTTP 202` means "still processing, poll again". Both `get_transcript` and `get_speaker_timeline` can return it. Polling is capped.
- `HTTP 507` is an idempotent replay and is treated as success.

## Troubleshooting

**The report says talk time was estimated from word count.**
Either no `bot_id` was available (you ran with `--transcript`), or `get_speaker_timeline` returned nothing. Re-run with `--bot <bot_id>`.

**All the talk time is attributed to one speaker.**
Diarisation collapsed. Set `TRANSCRIPT_PROVIDER=deepgram`, which requests `diarize: true`. Meetings with poor audio or a single shared room mic are the usual cause.

**"Could not parse JSON from the LLM response".**
Small models sometimes wrap JSON in prose. The parser strips code fences and hunts for the outermost object, so if it still fails, use a stronger model via `OPENAI_MODEL` or `ANTHROPIC_MODEL`.

**Sentiment looks flat across every section.**
Try raising `SENTIMENT_BUCKETS` for a longer meeting, or check that the transcript is not mostly one person presenting.

**"The transcript is empty, so there is nothing to analyse".**
The bot recorded silence, joined the wrong meeting, or the transcription provider failed. Check for a `transcription.failed` event in the console output.

**`get_transcript` returns 202 until the retry cap.**
The bot used a streaming-only provider. `deepgram_streaming`, `assemblyai_streaming`, `jigsawstack_streaming`, `meetstream_streaming` and `meeting_captions` never write a post-call transcript. Use `deepgram` or `meetstream`.
