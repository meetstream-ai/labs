# Post AI Meeting Summaries to Slack with the MeetStream API

A MeetStream meeting bot records your Zoom, Google Meet or Microsoft Teams meeting, then this script fetches the transcript and AI summary from the MeetStream API, optionally extracts action items with an LLM, and posts them into a Slack channel as formatted Block Kit blocks.

```bash
npm install
cp .env.example .env    # fill in MEETSTREAM_API_KEY and SLACK_WEBHOOK_URL
node index.js --meeting "https://meet.google.com/abc-defg-hij"
```

## What it does

1. `POST /bots/create_bot` with your `meeting_link` and a `callback_url`.
2. Serves a webhook and follows the bot lifecycle to `transcription.processed`.
3. Fetches the transcript with `GET /transcript/{transcript_id}/get_transcript`.
4. Reads the AI summary from `GET /bots/{bot_id}/summary` and attendees from `GET /bots/{bot_id}/get_participants`.
5. Optionally runs an LLM over the transcript to pull out action items with owners and due dates.
6. Posts a Block Kit message to Slack, and with a bot token can drop the full transcript into the message thread.

## Prerequisites

- Node 18 or newer.
- A MeetStream API key from <https://app.meetstream.ai>.
- Either a Slack incoming webhook URL or a bot token with `chat:write`.
- Optional: an OpenAI or Anthropic key for action items.
- For live mode, a public HTTPS URL. In development:
  ```bash
  ngrok http 3000
  # or
  cloudflared tunnel --url http://localhost:3000
  ```

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/slack-meeting-summary
npm install
cp .env.example .env    # then fill in MEETSTREAM_API_KEY and SLACK_WEBHOOK_URL (or a bot token)
node index.js --meeting "https://meet.google.com/abc-defg-hij"
```

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>` |
| `MEETING_LINK` | live mode | Zoom, Google Meet or Teams link; `--meeting` overrides it |
| `PUBLIC_BASE_URL` | live mode | Public HTTPS base URL; `callback_url` becomes `<url>/webhook`; `--public-url` overrides it |
| `PORT` | no | Local webhook port (default `3000`); `--port` overrides it |
| `BOT_NAME` | no | Bot display name (default `MeetStream Labs Bot`) |
| `TRANSCRIPT_PROVIDER` | no | Post-call provider: `meetstream` (default), `deepgram`, `assemblyai`, `sarvam`, `jigsawstack`. Never a `*_streaming` provider |
| `TRANSCRIPT_LANGUAGE` | no | Transcript language (default `en`) |
| `RETENTION_HOURS` | no | Timed retention in hours; unset keeps the API default of 30 days (720 h) |
| `TRANSCRIPT_POLL_ATTEMPTS` | no | Cap on `get_transcript` polls while it answers 202 (default `20`) |
| `TRANSCRIPT_POLL_INTERVAL_MS` | no | Delay between those polls (default `5000`) |
| `BOT_ID` | replay mode | Re-post for a finished bot; same as `--bot` |
| `TRANSCRIPT_ID` | replay mode | Fetch a specific transcript; same as `--transcript` |
| `SLACK_WEBHOOK_URL` | one of the two | Slack incoming webhook (option A) |
| `SLACK_BOT_TOKEN` / `SLACK_CHANNEL` | one of the two | Bot token with `chat:write` plus target channel (option B); wins if both are set |
| `SLACK_MESSAGE_TITLE` | no | Header text; `{date}` is replaced (default `Meeting notes - {date}`) |
| `POST_TRANSCRIPT_IN_THREAD` | no | `true` posts the transcript as a thread reply (bot token only) |
| `TRANSCRIPT_THREAD_TURNS` | no | Max transcript turns in the thread reply (default `60`) |
| `LLM_PROVIDER` | no | `openai` or `anthropic`; auto-detected from whichever key is set |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | no | OpenAI action-item extraction (default model `gpt-4o-mini`) |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | no | Anthropic action-item extraction (default model `claude-sonnet-4-5`) |
| `LLM_MAX_TRANSCRIPT_CHARS` | no | Cap on transcript characters sent to the model (default `60000`) |
| `MEETSTREAM_BASE_URL` | no | API base URL (default `https://api.meetstream.ai/api/v1`) |

### Slack, option A: incoming webhook

Create one at <https://api.slack.com/messaging/webhooks>, then set `SLACK_WEBHOOK_URL`. Simplest path. Posts to one fixed channel and cannot reply in threads.

### Slack, option B: bot token

1. Create an app at <https://api.slack.com/apps>.
2. Add the `chat:write` bot scope under OAuth and Permissions.
3. Install the app to the workspace and copy the `xoxb-` token into `SLACK_BOT_TOKEN`.
4. Set `SLACK_CHANNEL` to `#meeting-notes` or a channel ID.
5. Invite the bot: `/invite @your-bot`. Without this you get `not_in_channel`.

Set `POST_TRANSCRIPT_IN_THREAD=true` to keep the channel tidy: summary in the channel, transcript in the thread.

## Run

```bash
node index.js --meeting "https://meet.google.com/abc-defg-hij"   # live
node index.js --bot 8f2c1a3e-...                                  # replay
node index.js --transcript 4b71d0ca-...                           # replay
```

Replay mode is the fast way to iterate on message formatting without sitting through a meeting.

## How it works

```
index.js          orchestration for this template
src/pipeline.js   create the bot, serve the webhook, fetch the transcript
src/meetstream.js the MeetStream API client
src/slack.js      webhook vs bot token delivery
src/blocks.js     Block Kit builders, with Slack's size limits handled
src/actions.js    optional LLM action item extraction
src/llm.js        pluggable OpenAI / Anthropic client
```

The MeetStream details that matter:

- Auth is `Authorization: Token <key>`. The literal word `Token`, not `Bearer`.
- The create field is `meeting_link`, not `meeting_url`.
- Every webhook delivery carries `event` (the generic name); most also carry `bot_event` (the specific name). The event we wait for is `transcription.processed`; `bot.done` is the final event on every path.
- Every ending arrives once as `event: "bot.stopped"` and `bot_event` gives the reason: `bot.stopped` (200), `bot.kicked` (200), `bot.notallowed` (500), `bot.denied` (500), `bot.failed` (usually 500). `status_code` is not always 200. The pipeline branches on `bot_event` and falls back to a case-insensitive `bot_status` only when it is missing; a kick and a clean exit both report `Stopped`, so `bot_status` alone cannot tell them apart.
- `bot.error` is not terminal: a streaming-provider hiccup, the bot keeps running.
- Webhooks never include `transcript_id`. It comes from `create_bot`, `GET /bots/{id}/detail`, or `GET /bots/{id}/transcriptions`.
- The transcript is fetched by **transcript_id**, not bot_id, and its segments carry text in a field named `transcript`, not `text`.
- `HTTP 202` means "still processing, poll again". Polling is capped.
- `HTTP 507` is an idempotent replay and is treated as success.

Slack limits handled in `src/blocks.js`: 50 blocks per message, 3000 characters per section, 150 characters per header. Long summaries and transcripts are chunked across multiple section blocks rather than silently truncated.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing required environment variable: MEETSTREAM_API_KEY` | `.env` missing or empty | `cp .env.example .env` and add your key |
| Usage is printed and nothing runs | No `--meeting`, `--bot` or `--transcript`, and no `MEETING_LINK` / `BOT_ID` / `TRANSCRIPT_ID` in `.env` | Pass one of the flags |
| 401 / 403 from MeetStream | 401 = no key sent, 403 = key rejected | Check `MEETSTREAM_API_KEY` for stray quotes |
| 400 on `create_bot` | Bad `meeting_link`, or an option the API rejected | Use the full meeting URL |
| `bot.stopped` with `bot_event: bot.notallowed` / `bot.denied` / `bot.failed` | Never admitted, host refused, or internal failure | Nothing was recorded; the script exits 1. Admit the bot next time |
| `transcription.failed` (500) | The post-call provider failed | Re-run with `--bot <id>` after re-triggering transcription, or switch `TRANSCRIPT_PROVIDER` |
| `get_transcript` returns 202 until the retry cap | Still processing, or the bot used a streaming-only provider (`*_streaming`, `meeting_captions`), which never writes a post-call transcript | Raise `TRANSCRIPT_POLL_ATTEMPTS`, or use `meetstream` / `deepgram` |
| 404 on `get_transcript` | Wrong `transcript_id`, or the data expired via retention | Check `GET /bots/{id}/transcriptions` |
| No webhook events | `PUBLIC_BASE_URL` is not a public HTTPS URL pointing at `PORT`; deliveries are not retried | Hit `GET /health` through the tunnel; create a new bot after changing the URL |
| `not_in_channel` | The bot is not a member of `SLACK_CHANNEL` | Run `/invite @your-bot` in that channel |
| `missing_scope` | `chat:write` not granted | Add it under OAuth and Permissions, then reinstall the app |
| `invalid_blocks` | A section over 3000 characters | The builders chunk for you; if you edited them, check your chunk size |
| Message posts but action items are missing | No LLM key is set (designed fallback) | Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` |

## Related

- [Post-call transcription](https://docs.meetstream.ai/guides/transcription-recordings/post-call-transcription)
- [Get transcription](https://docs.meetstream.ai/api-reference/api-endpoints/transcription/get-transcription)
- [Get bot summary](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-summary)
- [Fetch participants](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/fetch-participants)
- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Transcription providers](https://docs.meetstream.ai/guides/transcription-recordings/providers/transcription-providers)
- [Slack Block Kit](https://api.slack.com/block-kit)
- Related templates: [../ai-meeting-summary](../ai-meeting-summary), [../action-item-extractor](../action-item-extractor), [../notion-meeting-notes](../notion-meeting-notes), [../transcript-fetcher](../transcript-fetcher)
