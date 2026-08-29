# Notion Meeting Notes

A MeetStream bot records your meeting, and this script files one Notion page per meeting containing the AI summary, the participants, the action items and the full transcript.

```bash
npm install
cp .env.example .env    # fill in MEETSTREAM_API_KEY, NOTION_API_KEY, NOTION_DATABASE_ID
node index.js --meeting "https://meet.google.com/abc-defg-hij"
```

## What it does

1. `POST /bots/create_bot` with your `meeting_link` and a `callback_url`.
2. Serves a webhook and follows the bot lifecycle to `transcription.processed`.
3. Fetches the transcript with `GET /transcript/{transcript_id}/get_transcript`.
4. Reads the summary from `GET /bots/{bot_id}/summary` and attendees from `GET /bots/{bot_id}/get_participants`.
5. Optionally extracts action items with an LLM.
6. Creates a Notion page: summary paragraphs, participant bullets, action items as checkboxes, transcript in a collapsed toggle.

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
npm install
cp .env.example .env
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
```

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
- The webhook envelope key is `event`. We act on `transcription.processed`.
- `bot.stopped` is always `status_code: 200`. Read `bot_status` for the reason: `Stopped`, `NotAllowed`, `Denied`, `Error`.
- Webhooks never include `transcript_id`. It comes from `create_bot`, `GET /bots/{id}/detail`, or `GET /bots/{id}/transcriptions`.
- The transcript is fetched by **transcript_id**, not bot_id, and segments carry text in a field named `transcript`, not `text`.
- `HTTP 202` means "still processing, poll again". Polling is capped.
- `HTTP 507` is an idempotent replay and is treated as success.

The Notion limits handled in `src/notion.js`: 2000 characters per `rich_text` object (long paragraphs are split across several), and 100 child blocks per request (the page is created with the first 100 and the rest are appended in batches).

## Troubleshooting

**Notion returns `404 object_not_found`.**
The integration is not connected to that database or page. Open it in Notion, `...` menu, Connections, add your integration. This is by far the most common failure.

**Notion returns `400 validation_error` about `children`.**
A block exceeded a limit. The builders chunk rich text at 2000 characters and children at 100 per request, so if you added custom blocks, check those two numbers.

**The title property is wrong or the page has no title.**
The script reads the database schema and uses whichever property has type `title`. If your database has none, Notion cannot accept pages at all.

**`get_transcript` returns 202 until the retry cap.**
The bot used a streaming-only provider. `deepgram_streaming`, `assemblyai_streaming`, `jigsawstack_streaming`, `meetstream_streaming` and `meeting_captions` never write a post-call transcript. Use `meetstream` or `deepgram`.

**No action items on the page.**
No LLM key is set. That is the designed fallback. Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.

**No webhook events.**
`PUBLIC_BASE_URL` must be a public HTTPS URL pointing at the same `PORT` the script listens on. Hit `GET /health` through the tunnel to confirm.
