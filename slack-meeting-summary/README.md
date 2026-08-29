# Slack Meeting Summary

A MeetStream bot records your meeting, then this script posts the AI summary and the extracted action items into a Slack channel as formatted Block Kit blocks.

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
npm install
cp .env.example .env
```

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
- The webhook envelope key is `event`, and the terminal-ish event we wait for is `transcription.processed`.
- `bot.stopped` is always `status_code: 200`. Read `bot_status` for the reason: `Stopped`, `NotAllowed`, `Denied`, `Error`.
- Webhooks never include `transcript_id`. It comes from `create_bot`, `GET /bots/{id}/detail`, or `GET /bots/{id}/transcriptions`.
- The transcript is fetched by **transcript_id**, not bot_id, and its segments carry text in a field named `transcript`, not `text`.
- `HTTP 202` means "still processing, poll again". Polling is capped.
- `HTTP 507` is an idempotent replay and is treated as success.

Slack limits handled in `src/blocks.js`: 50 blocks per message, 3000 characters per section, 150 characters per header. Long summaries and transcripts are chunked across multiple section blocks rather than silently truncated.

## Troubleshooting

**`not_in_channel`.**
The bot is not a member of `SLACK_CHANNEL`. Run `/invite @your-bot` in that channel.

**`missing_scope`.**
Add `chat:write` under OAuth and Permissions, then reinstall the app. Reinstalling is required for the new scope to take effect.

**`invalid_blocks`.**
Usually a section over 3000 characters. The builders chunk for you, so if you edited them, check your chunk size.

**The message posts but action items are missing.**
No LLM key is set. That is the designed fallback. Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.

**`get_transcript` returns 202 until the retry cap.**
The bot used a streaming-only provider. `deepgram_streaming`, `assemblyai_streaming`, `jigsawstack_streaming`, `meetstream_streaming` and `meeting_captions` never write a post-call transcript. Use `meetstream` or `deepgram`.

**No webhook events.**
`PUBLIC_BASE_URL` has to be a public HTTPS URL pointing at the same `PORT` the script listens on. Hit `GET /health` through the tunnel to confirm.
