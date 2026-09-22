# Sync Meeting Notes to HubSpot CRM with the MeetStream API

After a sales call on Zoom, Google Meet or Microsoft Teams, a MeetStream API meeting bot records and transcribes it, and this script attaches the AI summary, action items and transcript to the matching HubSpot contact and their deals as a single timeline note.

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
git clone https://github.com/meetstream-ai/labs.git
cd labs/crm-hubspot-sync
npm install
cp .env.example .env
```

Create the private app in HubSpot under **Settings > Integrations > Private Apps**, grant the three scopes above, and copy the access token into `HUBSPOT_ACCESS_TOKEN`.

## Environment variables

| Name | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | API key from <https://app.meetstream.ai>. Sent as `Authorization: Token <key>`. |
| `MEETSTREAM_BASE_URL` | no | API base URL. Default `https://api.meetstream.ai/api/v1`. |
| `HUBSPOT_ACCESS_TOKEN` | yes | HubSpot private app token with the three scopes above. |
| `HUBSPOT_PORTAL_ID` | no | Only used to print a clickable link to the created note. |
| `MEETING_LINK` | live mode | Zoom, Google Meet or Teams URL. `--meeting` overrides it. |
| `BOT_NAME` | no | Display name in the meeting. Default `MeetStream Labs Bot`. |
| `TRANSCRIPT_PROVIDER` | no | Post-call provider: `meetstream`, `deepgram`, `assemblyai`, `sarvam`, `jigsawstack`. Default `meetstream`. Never a `*_streaming` provider. |
| `TRANSCRIPT_LANGUAGE` | no | Transcription language code. Default `en`. |
| `RETENTION_HOURS` | no | Delete the recording after N hours. Default is the API default, 720 (30 days). |
| `PUBLIC_BASE_URL` | live mode | Public HTTPS URL of this server; `callback_url` is `${PUBLIC_BASE_URL}/webhook`. `--public-url` overrides it. |
| `PORT` | no | Local webhook port. Default `3000`. |
| `TRANSCRIPT_POLL_ATTEMPTS` | no | Max `get_transcript` polls while it returns 202. Default `20`. |
| `TRANSCRIPT_POLL_INTERVAL_MS` | no | Delay between polls. Default `5000`. |
| `BOT_ID` | replay | Replay a finished meeting by bot id. Same as `--bot`. |
| `TRANSCRIPT_ID` | replay | Replay a known transcript id. Same as `--transcript`. |
| `ATTENDEE_EMAILS` | recommended | Comma-separated attendee emails to match on. `--emails` overrides it. |
| `EXCLUDE_EMAIL_DOMAINS` | no | Comma-separated domains never to log against (your own team). |
| `ATTACH_TO_DEALS` | no | `false` skips deal associations. Default `true`. |
| `INCLUDE_TRANSCRIPT` | no | `false` omits the transcript from the note. Default `true`. |
| `NOTE_MAX_TRANSCRIPT_TURNS` | no | Speaker turns included in the note. Default `200`. |
| `NOTE_TITLE` | no | `{date}` is replaced with today's date. Default `Meeting notes - {date}`. |
| `LLM_PROVIDER` | no | `openai` or `anthropic`. Inferred from whichever key is set. Leave blank to skip action items. |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | no | OpenAI key and model. Default model `gpt-4o-mini`. |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | no | Anthropic key and model. Default model `claude-sonnet-4-5`. |
| `LLM_MAX_TRANSCRIPT_CHARS` | no | Transcript characters sent to the LLM. Default `60000`. |

### Attendee emails

Zoom, Google Meet and Microsoft Teams do not reliably expose attendee email addresses, so `GET /bots/{id}/get_participants` often returns display names only. Because of that, the dependable way to tell the script who was on the call is to pass the emails yourself:

```bash
node index.js --bot 8f2c1a3e-... --emails "buyer@acme.com,champion@acme.com"
```

or set `ATTENDEE_EMAILS` in `.env`. Any emails the platform *does* report are merged in automatically. Put your own domain in `EXCLUDE_EMAIL_DOMAINS` so the note is not logged against your own reps.

**Recording defaults.** This template records audio only: it sends `video_required: false` explicitly, because the REST API treats an omitted `video_required` as true. If you turn video on in code, it sends `recording_config.video_layout: "speaker_view"` (the API default is `grid_view`, so speaker view has to be explicit); use `grid_view` only when you want the composited mosaic of everyone. Per-participant video (`video_separate_streams`) is never enabled implicitly.

## Run

```bash
node index.js --meeting "https://us02web.zoom.us/j/000000000" --emails "buyer@acme.com"   # live
node index.js --bot 8f2c1a3e-... --emails "buyer@acme.com"                                # replay
node index.js --transcript 4b71d0ca-... --emails "buyer@acme.com"                         # replay
```

## What you should see

Replay mode (`--bot <bot_id>`), with no LLM key set:

```text
=== MeetStream Labs · CRM HubSpot Sync ===

LLM for action items: none
Looking up the transcript_id for bot <bot_id>...
Found transcript_id: <transcript_id>

Fetching transcript <transcript_id> ...
Got 142 transcript segments.

Matching on: buyer@acme.com, champion@acme.com
  Matched buyer@acme.com to contact <contact_id> (Jane Buyer)
  No HubSpot contact found for champion@acme.com. Skipping.
  Deal <deal_id>: Acme - Platform rollout [qualifiedtobuy]
  No LLM key set, skipping action items. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.
Extracted 0 action items.
Logged note <note_id> on 1 contact(s) and 1 deal(s).
https://app.hubspot.com/contacts/<portal_id>/objects/0-46/<note_id>

Done.
```

The last URL is printed only when `HUBSPOT_PORTAL_ID` is set; otherwise the line reads `note <note_id>`. With `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` set, the first line reads `LLM for action items: openai/gpt-4o-mini` (or `anthropic/claude-sonnet-4-5`) and `Extracted N action items.` reports what the model found.

Live mode (`--meeting <url>`) first prints the webhook server and the created bot, then one line per lifecycle event until the transcript is ready, then the same tail as above:

```text
Webhook server listening on http://localhost:3000
Public callback_url: https://<your-tunnel>/webhook

Bot created.
  bot_id        : <bot_id>
  transcript_id : <transcript_id>
  status        : Joining

Waiting for the meeting to finish...

[bot.joining] Bot is dialling into the meeting.
[bot.in_waiting_room] Bot is in the waiting room - someone needs to admit it.
[bot.inmeeting] Bot joined the meeting.
[bot.recording] Recording started.
[bot.leaving] Bot is leaving.
[bot.stopped] Bot stopped: bot.stopped (status_code 200)
[manifest.completed] ...
[audio.processed] ...
[transcription.processed] Transcript is ready.

Fetching transcript <transcript_id> ...
  Transcript not ready (HTTP 202) - retry 1/20 in 5000ms
Got 142 transcript segments.
```

Exit codes: `0` after `Done.`; `1` on a missing variable (`Missing required environment variable: MEETSTREAM_API_KEY`), on `bot.stopped` with `bot_event` `bot.notallowed`, `bot.denied` or `bot.failed`, on `transcription.failed`, on `bot.done` arriving before `transcription.processed`, or when `get_transcript` is still 202 after `TRANSCRIPT_POLL_ATTEMPTS`.

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
- Every webhook carries `event`; most also carry `bot_event` with the specific name, so read `bot_event ?? event`. The pipeline acts on `transcription.processed` and treats `bot.done` as the final event on every path.
- Every ending arrives as `event: "bot.stopped"` and `bot_event` gives the reason: `bot.stopped` (clean, 200), `bot.kicked` (200), `bot.notallowed` (lobby timeout, 500), `bot.denied` (host refused, 500), `bot.failed` (usually 500). `status_code` is not always 200. Branch on `bot_event`, not `bot_status`: a kick and a clean exit both say `Stopped`. The pipeline falls back to `bot_status` (case-insensitive) only when `bot_event` is missing.
- Webhooks never include `transcript_id`. It comes from `create_bot`, `GET /bots/{id}/detail`, or `GET /bots/{id}/transcriptions`.
- The transcript is fetched by **transcript_id**, not bot_id, and segments carry text in a field named `transcript`, not `text`.
- `HTTP 202` means "still processing, poll again". Polling is capped.
- `HTTP 507` is an idempotent replay and is treated as success.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing required environment variable: MEETSTREAM_API_KEY` | `.env` not created or key blank | `cp .env.example .env` and fill in the key. |
| MeetStream 401 | No `Authorization` header sent | Check `.env` is loaded and the key is not empty. |
| MeetStream 403 | Key present but wrong | Regenerate the key in the dashboard. |
| `get_transcript` returns 202 until the retry cap | Bot used a streaming-only provider (`*_streaming`, `meeting_captions`); those never write a post-call transcript | Use `meetstream`, `deepgram`, `assemblyai`, `sarvam` or `jigsawstack`. |
| `bot.done` arrived with no `transcription.processed` | No post-call transcript exists for this bot | The pipeline exits; re-check the provider. |
| `bot.stopped` with `bot_event: bot.notallowed` (500) | Nobody admitted the bot before the waiting-room timeout | Admit it sooner, or raise `automatic_leave.waiting_room_timeout`. |
| No webhook events | `PUBLIC_BASE_URL` is not public HTTPS, or the tunnel points at another port | Hit `GET /health` through the tunnel, then match `PORT`. |
| MeetStream 507 | Idempotent replay of a request already made | Treated as success; the existing bot is reused. |
| HubSpot 401 | `HUBSPOT_ACCESS_TOKEN` missing or expired | Regenerate the private app token. |
| HubSpot 403 | Private app is missing a scope | Add `crm.objects.contacts.read`, `crm.objects.deals.read`, `crm.objects.notes.write`, then refresh the token. |
| `None of the attendee emails matched a HubSpot contact` | Email not in the portal, different casing, or on a secondary email property (search is an exact match on primary `email`) | Create the contact first, or pass an email you know exists. |
| `No attendee emails to match on` | Platform reported no emails and none were passed | Use `--emails` or `ATTENDEE_EMAILS`. |
| Note on the contact but not the deal | Contact has no associated deals, or `ATTACH_TO_DEALS=false` | Check the console output, which lists every deal found. |
| HubSpot 400 on note creation | Association type id does not match the object pair | Note to contact is `202`, note to deal is `214`. |

## Related

- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [Get transcription](https://docs.meetstream.ai/api-reference/api-endpoints/transcription/get-transcription)
- [Get bot summary](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-summary)
- [Fetch participants](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/fetch-participants)
- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Post-call transcription](https://docs.meetstream.ai/guides/transcription-recordings/post-call-transcription)
- [Error codes](https://docs.meetstream.ai/errors)
- Labs: [ai-meeting-notetaker-email](../ai-meeting-notetaker-email), [action-item-extractor](../action-item-extractor), [notion-meeting-notes](../notion-meeting-notes)
