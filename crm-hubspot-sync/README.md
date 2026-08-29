# CRM HubSpot Sync

After a sales call, attach the MeetStream summary, action items and transcript to the matching HubSpot contact and their deals as a note.

```bash
npm install
cp .env.example .env    # fill in MEETSTREAM_API_KEY and HUBSPOT_ACCESS_TOKEN
node index.js --bot <bot_id> --emails "buyer@acme.com"
```

## What it does

1. `POST /bots/create_bot` with your `meeting_link` and a `callback_url`.
2. Serves a webhook and follows the bot lifecycle to `transcription.processed`.
3. Fetches the transcript with `GET /transcript/{transcript_id}/get_transcript`.
4. Reads the summary from `GET /bots/{bot_id}/summary` and attendees from `GET /bots/{bot_id}/get_participants`.
5. Searches HubSpot for a contact with each attendee email.
6. Reads the deals associated with those contacts.
7. Optionally extracts action items with an LLM.
8. Creates **one** note and associates it with every matched contact and deal, so the call shows up on the right timelines without duplicating itself.

## Prerequisites

- Node 18 or newer.
- A MeetStream API key from <https://app.meetstream.ai>.
- A HubSpot private app access token with these scopes:
  - `crm.objects.contacts.read`
  - `crm.objects.deals.read`
  - `crm.objects.notes.write`
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

Create the private app in HubSpot under **Settings > Integrations > Private Apps**, grant the three scopes above, and copy the access token into `HUBSPOT_ACCESS_TOKEN`.

### Attendee emails

Zoom, Google Meet and Microsoft Teams do not reliably expose attendee email addresses, so `GET /bots/{id}/get_participants` often returns display names only. Because of that, the dependable way to tell the script who was on the call is to pass the emails yourself:

```bash
node index.js --bot 8f2c1a3e-... --emails "buyer@acme.com,champion@acme.com"
```

or set `ATTENDEE_EMAILS` in `.env`. Any emails the platform *does* report are merged in automatically. Put your own domain in `EXCLUDE_EMAIL_DOMAINS` so the note is not logged against your own reps.

## Run

```bash
node index.js --meeting "https://us02web.zoom.us/j/000000000" --emails "buyer@acme.com"   # live
node index.js --bot 8f2c1a3e-... --emails "buyer@acme.com"                                # replay
node index.js --transcript 4b71d0ca-... --emails "buyer@acme.com"                         # replay
```

## How it works

```
index.js          orchestration for this template
src/pipeline.js   create the bot, serve the webhook, fetch the transcript
src/meetstream.js the MeetStream API client
src/hubspot.js    contact search, deal associations, note creation
src/note.js       the HTML body HubSpot renders on the timeline
src/actions.js    optional LLM action item extraction
src/llm.js        pluggable OpenAI / Anthropic client
```

HubSpot specifics worth knowing:

- Contacts are found with `POST /crm/v3/objects/contacts/search`, exact match on `email`.
- Deals come from the v4 associations API: `GET /crm/v4/objects/contacts/{id}/associations/deals`.
- Notes are created on `POST /crm/v3/objects/notes`. `hs_timestamp` is required, and `hs_note_body` is capped at 65536 characters, which the client enforces.
- Associations use HubSpot's default type IDs: note to contact is `202`, note to deal is `214`, note to company is `190`.

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

**HubSpot returns 403.**
The private app is missing a scope. Add `crm.objects.contacts.read`, `crm.objects.deals.read` and `crm.objects.notes.write`, then regenerate or refresh the token.

**"None of the attendee emails matched a HubSpot contact".**
The email is not in your portal, or it is stored with different casing or on a secondary email property. The search here is an exact match on the primary `email` property. Create the contact first, or pass an email you know exists.

**"No attendee emails to match on".**
The meeting platform reported no emails and you did not pass any. Use `--emails` or `ATTENDEE_EMAILS`.

**The note appears on the contact but not the deal.**
The contact has no associated deals, or `ATTACH_TO_DEALS=false`. Check the console output, which lists every deal it found.

**HubSpot returns 400 on note creation.**
Usually an association type ID that does not match the object pair. Note to contact must be `202`, note to deal must be `214`.

**`get_transcript` returns 202 until the retry cap.**
The bot used a streaming-only provider. `deepgram_streaming`, `assemblyai_streaming`, `jigsawstack_streaming`, `meetstream_streaming` and `meeting_captions` never write a post-call transcript. Use `meetstream` or `deepgram`.

**No webhook events.**
`PUBLIC_BASE_URL` must be a public HTTPS URL pointing at the same `PORT` the script listens on. Hit `GET /health` through the tunnel to confirm.
