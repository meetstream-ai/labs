# Meeting Sentiment Analysis and Coaching Insights with the MeetStream API

Analyse a MeetStream meeting transcript from a Zoom, Google Meet or Microsoft Teams call for sentiment trends, topics and talk-time balance, and produce a coaching-style report as Markdown plus JSON. Talk time comes from the MeetStream speaker timeline API; the sentiment and coaching analysis comes from an OpenAI or Anthropic model.

## What it does

1. `POST /bots/create_bot` with your `meeting_link`, a post-call transcription provider and a `callback_url`.
2. Serves a webhook and follows the bot lifecycle to `transcription.processed`.
3. Fetches the transcript with `GET /transcript/{transcript_id}/get_transcript`, polling through HTTP 202 with a cap.
4. Pulls measured speaking time from `GET /bots/{bot_id}/get_speaker_timeline`.
5. Reads MeetStream's AI summary from `GET /bots/{bot_id}/summary` as framing.
6. Splits the transcript into chronological sections and asks an LLM how sentiment moved, what was discussed, what the risks were, and what to do differently.
7. Writes `output/insights-<transcript_id>.json` and `output/insights-<transcript_id>.md`.

Replay mode (`--bot` or `--transcript`) skips steps 1 and 2 and runs against a meeting that already finished.

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
git clone https://github.com/meetstream-ai/labs.git
cd labs/sentiment-and-insights
npm install
cp .env.example .env    # fill in MEETSTREAM_API_KEY and OPENAI_API_KEY (or ANTHROPIC_API_KEY)
node index.js --bot <bot_id>
```

`.env.example` sets `TRANSCRIPT_PROVIDER=deepgram`, which is configured with `diarize: true`, because clean per-speaker attribution is what makes the talk-time numbers worth reading.

## Run

```bash
node index.js --meeting "https://meet.google.com/abc-defg-hij"   # live
node index.js --bot 8f2c1a3e-...                                  # replay
node index.js --transcript 4b71d0ca-...                           # replay
node index.js --help
```

Pass `--bot` rather than `--transcript` when you can. The speaker timeline is fetched per bot, so a bot ID gets you measured talk time instead of an estimate.

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>`. |
| `OPENAI_API_KEY` | one of | Enables the analysis via OpenAI. |
| `ANTHROPIC_API_KEY` | one of | Enables the analysis via Anthropic. |
| `LLM_PROVIDER` | no | `openai` or `anthropic`. Unset picks whichever key is present. |
| `OPENAI_MODEL` | no | Default `gpt-4o-mini`. |
| `ANTHROPIC_MODEL` | no | Default `claude-sonnet-4-5`. |
| `LLM_MAX_TRANSCRIPT_CHARS` | no | Transcript characters sent to the LLM, split across sections. Default `60000`. |
| `LLM_MAX_TOKENS` | no | Max tokens for the analysis response. Default `3000`. |
| `SENTIMENT_BUCKETS` | no | Chronological sections to score sentiment across. Default `3`. |
| `MEETING_LINK` | live mode | Zoom, Google Meet or Teams link. `--meeting` overrides. |
| `PUBLIC_BASE_URL` | live mode | Public https:// base; `callback_url` becomes `<url>/webhook`. `--public-url` overrides. |
| `PORT` | no | Local webhook port. Default `3000`. `--port` overrides. |
| `BOT_ID` | replay mode | Finished bot to replay. `--bot` overrides. |
| `TRANSCRIPT_ID` | replay mode | Known transcript to replay. `--transcript` overrides. |
| `BOT_NAME` | no | Display name in the meeting. Default `MeetStream Labs Bot`. |
| `TRANSCRIPT_PROVIDER` | no | Post-call provider: `deepgram`, `assemblyai`, `sarvam`, `jigsawstack` or `meetstream`. Code default `meetstream`; `.env.example` sets `deepgram`. |
| `TRANSCRIPT_LANGUAGE` | no | Language passed to the provider. Default `en`. |
| `RETENTION_HOURS` | no | `recording_config.retention.hours`. Unset means the API default of 720 (30 days). |
| `TRANSCRIPT_POLL_ATTEMPTS` | no | Cap on `get_transcript` polls while it answers 202. Default `20`. |
| `TRANSCRIPT_POLL_INTERVAL_MS` | no | Delay between those polls. Default `5000`. |
| `OUTPUT_DIR` | no | Where the JSON and Markdown reports are written. Default `output`. |
| `PRINT_REPORT` | no | `false` skips printing the Markdown to stdout. Default `true`. |
| `MEETSTREAM_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |

## Talk time: measured or estimated

The report always states which source it used, in this order:

1. **`get_speaker_timeline`**: real measured speaking intervals. This is what you want, and it needs a `bot_id`.
2. **Transcript segment timings**: used when the timeline is unavailable but the transcript segments carry `start_time` and `end_time`.
3. **Word-count estimate at 150 wpm**: the last resort, and labelled as an estimate in the report so nobody mistakes it for a measurement.

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
- Every webhook carries the generic name under `event`; most also carry `bot_event`. We act on `event: "transcription.processed"`.
- Every ending arrives as `event: "bot.stopped"` with the reason in `bot_event`: `bot.stopped` or `bot.kicked` (`status_code` 200), `bot.notallowed`, `bot.denied` or `bot.failed` (`status_code` 500). `bot_status` cannot tell a kick from a clean exit (both say `Stopped`), so the script reads `bot_event` and only falls back to a case-insensitive `bot_status` comparison when it is missing.
- `bot.done` is the final event on every path. Streaming-only providers never send `transcription.processed`, which is why this template only accepts post-call providers.
- Webhooks never include `transcript_id`. It comes from `create_bot`, `GET /bots/{id}/detail`, or `GET /bots/{id}/transcriptions`.
- The transcript is fetched by **transcript_id**, not bot_id, and segments carry text in a field named `transcript`, not `text`.
- `HTTP 202` means "still processing, poll again". Both `get_transcript` and `get_speaker_timeline` can return it. Polling is capped.
- `HTTP 507` is an idempotent replay and is treated as success.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Missing required environment variable: MEETSTREAM_API_KEY` | No `.env` or empty key. | `cp .env.example .env` and paste your key. |
| `This template needs an LLM` | Neither `OPENAI_API_KEY` nor `ANTHROPIC_API_KEY` is set. | Set one of them. |
| `MeetStream API error 401` / `403` | No key sent, or the key was rejected. | Check the key is complete and active for this workspace. |
| `MeetStream API error 400` on create | Invalid `meeting_link`, or an unknown transcription provider. | Paste a full link; use one of the five post-call providers. |
| `MeetStream API error 404` in replay mode | Wrong bot or transcript id, or the data expired via retention. | Confirm the id with `GET /bots`. |
| `PUBLIC_BASE_URL is required in live mode` | No public URL for the webhook. | Start `ngrok http 3000` and set `PUBLIC_BASE_URL` to the https URL. |
| Bot stopped with `bot.notallowed` or `bot.denied` | Lobby timeout, or the host refused the bot. | Admit the bot next time; there is no recording to analyse. |
| The report says talk time was estimated from word count | No `bot_id` was available (`--transcript`), or `get_speaker_timeline` returned nothing. | Re-run with `--bot <bot_id>`. |
| All the talk time is attributed to one speaker | Diarisation collapsed, usually poor audio or a single shared room mic. | Set `TRANSCRIPT_PROVIDER=deepgram`, which requests `diarize: true`. |
| `Could not parse JSON from the LLM response` | A small model wrapped the JSON in prose beyond what the parser tolerates. | Use a stronger model via `OPENAI_MODEL` or `ANTHROPIC_MODEL`. |
| Sentiment looks flat across every section | Too few sections for a long meeting, or one person presenting throughout. | Raise `SENTIMENT_BUCKETS`. |
| `The transcript is empty, so there is nothing to analyse` | The bot recorded silence, joined the wrong meeting, or the provider failed. | Check for a `transcription.failed` event in the console output. |
| `get_transcript` returns 202 until the retry cap | The bot used a streaming-only provider, or processing is slow. | Use `deepgram` or `meetstream`; raise `TRANSCRIPT_POLL_ATTEMPTS` or replay later with `--bot`. |

## Related

- [Get speaker timeline](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-speaker-timeline)
- [Participants and speaker timeline guide](https://docs.meetstream.ai/guides/features/participants-and-speaker-timeline)
- [Diarization](https://docs.meetstream.ai/guides/transcription-recordings/diarization)
- [Post-call transcription](https://docs.meetstream.ai/guides/transcription-recordings/post-call-transcription)
- [Get transcription](https://docs.meetstream.ai/api-reference/api-endpoints/transcription/get-transcription)
- [Get bot summary](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-summary)
- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Error reference](https://docs.meetstream.ai/errors)
- Templates: [speaker-timeline-analytics](../speaker-timeline-analytics/README.md), [meeting-analytics-dashboard](../meeting-analytics-dashboard/README.md), [action-item-extractor](../action-item-extractor/README.md), [notion-meeting-notes](../notion-meeting-notes/README.md)
