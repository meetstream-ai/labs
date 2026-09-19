# Send Meeting Notes to Notion with the MeetStream API

A MeetStream meeting bot records your Zoom, Google Meet or Microsoft Teams call, and this script files one Notion page per meeting containing the AI summary, the participants, LLM-extracted action items and the full transcript, driven by MeetStream webhooks and the post-call transcription API.

## What it does

1. `POST /bots/create_bot` with your `meeting_link`, a post-call transcription provider and a `callback_url`.
2. Serves a webhook and follows the bot lifecycle to `transcription.processed`.
3. Fetches the transcript with `GET /transcript/{transcript_id}/get_transcript`, polling through HTTP 202 with a cap.
4. Reads the summary from `GET /bots/{bot_id}/summary` and attendees from `GET /bots/{bot_id}/get_participants`.
5. Optionally extracts action items with an LLM.
6. Creates a Notion page: summary paragraphs, participant bullets, action items as checkboxes, transcript in a collapsed toggle.

Replay mode (`--bot` or `--transcript`) skips steps 1 and 2 and runs against a meeting that already finished.

## Prerequisites

- Node 18 or newer.
- A MeetStream API key from <https://app.meetstream.ai>.
- A Notion internal integration secret from <https://www.notion.so/my-integrations>.
- A Notion database (recommended) or a parent page, shared with that integration.
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
cd labs/notion-meeting-notes
npm install
cp .env.example .env    # fill in MEETSTREAM_API_KEY, NOTION_API_KEY, NOTION_DATABASE_ID, PUBLIC_BASE_URL
node index.js --meeting "https://meet.google.com/abc-defg-hij"
```

### Connecting Notion

1. Create an internal integration at <https://www.notion.so/my-integrations> and copy the secret into `NOTION_API_KEY`.
2. Open the database you want the notes in. Click the `...` menu, then **Connections**, then add your integration. Without this step every request returns `404 object_not_found`, even though the ID is correct.
3. Copy the database ID into `NOTION_DATABASE_ID`. Pasting the full Notion URL works too, the 32 hex characters are extracted for you.

The script looks up the database's title property by type, so it does not matter whether yours is called `Name`, `Meeting` or anything else. If you also set `NOTION_DATE_PROPERTY` to the name of a Date property, the meeting date is stamped into it.

To file notes under a plain page instead of a database, set `NOTION_PARENT_PAGE_ID` and leave `NOTION_DATABASE_ID` empty.

## Run

```bash
node index.js --meeting "https://meet.google.com/abc-defg-hij"   # live
node index.js --bot 8f2c1a3e-...                                  # replay
node index.js --transcript 4b71d0ca-...                           # replay
node index.js --help
```

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>`. |
| `NOTION_API_KEY` | yes | Notion internal integration secret. |
| `NOTION_DATABASE_ID` | one of | Database the page is created in. Accepts a full Notion URL. |
| `NOTION_PARENT_PAGE_ID` | one of | Parent page, used when no database is set. |
| `MEETING_LINK` | live mode | Zoom, Google Meet or Teams link. `--meeting` overrides. |
| `PUBLIC_BASE_URL` | live mode | Public https:// base; `callback_url` becomes `<url>/webhook`. `--public-url` overrides. |
| `PORT` | no | Local webhook port. Default `3000`. `--port` overrides. |
| `BOT_ID` | replay mode | Finished bot to replay. `--bot` overrides. |
| `TRANSCRIPT_ID` | replay mode | Known transcript to replay. `--transcript` overrides. |
| `BOT_NAME` | no | Display name in the meeting. Default `MeetStream Labs Bot`. |
| `TRANSCRIPT_PROVIDER` | no | Post-call provider: `deepgram`, `assemblyai`, `sarvam`, `jigsawstack` or `meetstream`. Default `meetstream`. |
| `TRANSCRIPT_LANGUAGE` | no | Language passed to the provider. Default `en`. |
| `RETENTION_HOURS` | no | `recording_config.retention.hours`. Unset means the API default of 720 (30 days). |
| `TRANSCRIPT_POLL_ATTEMPTS` | no | Cap on `get_transcript` polls while it answers 202. Default `20`. |
| `TRANSCRIPT_POLL_INTERVAL_MS` | no | Delay between those polls. Default `5000`. |
| `NOTION_DATE_PROPERTY` | no | Name of a Date property to stamp with the meeting date. |
| `NOTION_PAGE_TITLE` | no | Page title; `{date}` is replaced. Default `Meeting notes - {date}`. |
| `NOTION_MAX_TRANSCRIPT_TURNS` | no | Cap on speaker turns written to the page. Default `400`. |
| `LLM_PROVIDER` | no | `openai` or `anthropic`. Unset picks whichever key is present. |
| `OPENAI_API_KEY` | no | Enables action items via OpenAI. |
| `OPENAI_MODEL` | no | Default `gpt-4o-mini`. |
| `ANTHROPIC_API_KEY` | no | Enables action items via Anthropic. |
| `ANTHROPIC_MODEL` | no | Default `claude-sonnet-4-5`. |
| `LLM_MAX_TRANSCRIPT_CHARS` | no | Transcript characters sent to the LLM. Default `60000`. |
| `MEETSTREAM_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |

## How it works

```
index.js          orchestration for this template
src/pipeline.js   create the bot, serve the webhook, fetch the transcript
src/meetstream.js the MeetStream API client
src/notion.js     Notion API client and block builders
src/page.js       the page layout for one meeting
src/actions.js    optional LLM action item extraction
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
- `HTTP 202` means "still processing, poll again". Polling is capped.
- `HTTP 507` is an idempotent replay and is treated as success.

The Notion limits handled in `src/notion.js`: 2000 characters per `rich_text` object (long paragraphs are split across several), and 100 child blocks per request (the page is created with the first 100 and the rest are appended in batches).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Missing required environment variable: MEETSTREAM_API_KEY` | No `.env` or empty key. | `cp .env.example .env` and paste your key. |
| `MeetStream API error 401` / `403` | No key sent, or the key was rejected. | Check the key is complete and active for this workspace. |
| `MeetStream API error 400` on create | Invalid `meeting_link`, or an unknown transcription provider. | Paste a full link; use one of the five post-call providers. |
| `MeetStream API error 404` in replay mode | Wrong bot or transcript id, or the data expired via retention. | Confirm the id with `GET /bots`. |
| `PUBLIC_BASE_URL is required in live mode` | No public URL for the webhook. | Start `ngrok http 3000` and set `PUBLIC_BASE_URL` to the https URL. |
| No webhook events | `PUBLIC_BASE_URL` does not reach the `PORT` the script listens on. | Hit `GET /health` through the tunnel to confirm. |
| Bot stopped with `bot.notallowed` or `bot.denied` | Lobby timeout, or the host refused the bot. | Admit the bot next time; there is no recording to process. |
| `get_transcript` returns 202 until the retry cap | The bot used a streaming-only provider, or processing is slow. | Use `meetstream` or `deepgram`; raise `TRANSCRIPT_POLL_ATTEMPTS` or replay later with `--bot`. |
| `No transcript_id found for bot` | The bot used a streaming-only provider (`transcript_id: null`). | Re-run with a post-call provider. |
| Notion returns `404 object_not_found` | The integration is not connected to that database or page. | Open it in Notion, `...` menu, Connections, add your integration. |
| Notion returns `400 validation_error` about `children` | A block exceeded a limit. | The builders chunk rich text at 2000 characters and children at 100 per request; check those numbers if you added custom blocks. |
| The title property is wrong or the page has no title | The database has no property of type `title`. | Add one; Notion cannot accept pages without it. |
| No action items on the page | No LLM key is set. That is the designed fallback. | Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. |

## Related

- [Post-call transcription](https://docs.meetstream.ai/guides/transcription-recordings/post-call-transcription)
- [Get transcription](https://docs.meetstream.ai/api-reference/api-endpoints/transcription/get-transcription)
- [Get bot summary](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-summary)
- [Fetch participants](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/fetch-participants)
- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Local webhook server](https://docs.meetstream.ai/guides/webhooks/local-webhook-server)
- [Error reference](https://docs.meetstream.ai/errors)
- Templates: [slack-meeting-summary](../slack-meeting-summary/README.md), [crm-hubspot-sync](../crm-hubspot-sync/README.md), [transcript-fetcher](../transcript-fetcher/README.md), [webhook-local-tunnel](../webhook-local-tunnel/README.md)
