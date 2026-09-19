# Record and Transcribe Meetings with the MeetStream API

A MeetStream meeting bot joins your Zoom, Google Meet or Microsoft Teams meeting, records it, and saves the full post-call transcript to a text file once the call ends. It opens an ngrok tunnel for the lifecycle webhooks, waits for `transcription.processed`, then fetches the transcript by `transcript_id`.

```bash
npm install
cp .env.example .env      # add your MEETSTREAM_API_KEY, MEETING_LINK and ngrok token
node index.js
```

Non-technical walkthrough, including ngrok signup: **[quickstart.md](./quickstart.md)**

## What it does

1. Starts a local webhook server and opens an ngrok tunnel to it.
2. `POST /bots/create_bot` with `meeting_link`, `bot_name`, `callback_url` pointed at the tunnel, and the post-call `meetstream` transcript provider. The response carries `transcript_id`; the template keeps it.
3. Follows the lifecycle webhooks: `bot.joining` -> `bot.in_waiting_room` -> `bot.inmeeting` -> `bot.recording` -> `bot.leaving` -> `bot.stopped` (reason in `bot_event`) -> `audio.processed` -> `transcription.processed` -> `bot.done`.
4. On `transcription.processed`, fetches `GET /transcript/{transcript_id}/get_transcript` (polling while it answers 202, with a cap) and writes `transcripts/<transcript_id>.txt` and `.json`.

## Prerequisites

- Node.js 18 or newer
- A MeetStream API key - [get one here](https://app.meetstream.ai/api-key)
- A free ngrok authtoken, so MeetStream can reach the webhook on your machine

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/post-call-transcription
npm install
cp .env.example .env      # fill in MEETSTREAM_API_KEY, MEETING_LINK, NGROK_AUTHTOKEN
node index.js
```

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>`. |
| `MEETING_LINK` | yes | Zoom, Google Meet or Teams link the bot joins. |
| `NGROK_AUTHTOKEN` | yes | ngrok authtoken; the tunnel is opened by the bundled `@ngrok/ngrok`. |
| `PORT` | no | Local webhook port. Default `3000`. |
| `BOT_NAME` | no | Display name in the meeting. Default `MeetStream Transcription Bot`. |
| `WEBHOOK_SECRET` | no | HMAC secret; when set, `X-MeetStream-Signature` is verified and mismatches are rejected. |
| `TRANSCRIPT_POLL_ATTEMPTS` | no | Cap on `get_transcript` polls while the API answers 202. Default `12`. |
| `TRANSCRIPT_POLL_INTERVAL_MS` | no | Delay between transcript polls. Default `5000`. |
| `OUTPUT_DIR` | no | Where the `.txt` and `.json` files go. Default `transcripts`. |
| `MEETSTREAM_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |

## How it works

```
index.js            entry: --help, env checks, tunnel -> server -> bot
src/tunnel.js       @ngrok/ngrok tunnel to PORT
src/webhook.js      express receiver, lifecycle handling, optional signature check
src/bot.js          POST /bots/create_bot
src/transcript.js   get_transcript with a capped 202 poll, transcript_id lookup, .txt/.json output
src/client.js       fetch wrapper: Token auth, 202 returned not thrown, 507 as success, API message surfaced
src/state.js        the bot_id / transcript_id for this run
```

The MeetStream details that matter:

- Auth is `Authorization: Token <key>`, not `Bearer`.
- `create_bot` needs both `meeting_link` and `bot_name`, and answers 201.
- Webhooks never carry `transcript_id`. It comes from the `create_bot` response; if that is missing, the template looks it up on `GET /bots/{id}/detail` and `GET /bots/{id}/transcriptions`.
- Every ending arrives as `event: "bot.stopped"` with the reason in `bot_event`: `bot.stopped` (200), `bot.kicked` (200), `bot.notallowed` (500), `bot.denied` (500), `bot.failed` (usually 500). The template branches on `bot_event` and falls back to a case-insensitive `bot_status` only when it is missing. `notallowed` / `denied` mean nothing was recorded, so it exits immediately.
- `bot.error` is not terminal; the bot keeps running.
- `bot.done` is the final event on every path. If it arrives without `transcription.processed`, no post-call transcript exists and the template exits 1.
- `HTTP 202` from `get_transcript` means "still processing"; polling is capped. `HTTP 507` is an idempotent replay and counts as success.
- Transcript segments carry their text in `transcript`, not `text`.
- MeetStream does not retry webhook deliveries, so the handler acknowledges with 200 before doing any work.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `MEETSTREAM_API_KEY is not set` | No `.env`, or an empty key. | `cp .env.example .env` and paste your key. |
| `NGROK_AUTHTOKEN is not set` | No ngrok token. | Copy it from the ngrok dashboard into `.env`. |
| `Failed to create bot: HTTP 401 / 403` | No key was sent, or the key was rejected. | Check `.env` is loaded from this folder; regenerate the key if 403 persists. |
| `Failed to create bot: HTTP 400` | `meeting_link` or `bot_name` missing, or an invalid link. | Check `MEETING_LINK`. |
| `Port 3000 is already in use` | Another process owns the port. | Stop it or set `PORT`. |
| Bot joins but no webhooks print | MeetStream cannot reach the tunnel. | Check the ngrok URL printed at start; `curl <url>/health`. |
| `Bot stopped - reason: bot.notallowed` | Nobody admitted the bot before the waiting-room timeout. | Admit it faster next time. |
| `Bot stopped - reason: bot.denied` | The host refused the bot. | Ask the host to admit it. |
| `bot.done arrived without transcription.processed` | No post-call transcript exists (nothing recorded, or a streaming-only provider). | This template uses the post-call `meetstream` provider; check the bot in the dashboard. |
| `Transcript still returned HTTP 202 after 12 attempts` | Transcription is taking longer than the poll window. | Raise `TRANSCRIPT_POLL_ATTEMPTS`, or fetch later with the printed `transcript_id`. |
| `HTTP 404` on `get_transcript` | Wrong `transcript_id`, or the recording expired via its retention window (default 30 days). | Confirm the id with `GET /bots/{id}/transcriptions`. |
| `Webhook signature mismatch` | `WEBHOOK_SECRET` does not match what MeetStream signs with. | Unset it, or use the same secret configured in MeetStream. |

## Related

- [Post-call transcription](https://docs.meetstream.ai/guides/transcription-recordings/post-call-transcription)
- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Local webhook server](https://docs.meetstream.ai/guides/webhooks/local-webhook-server)
- [Webhook signature verification](https://docs.meetstream.ai/guides/webhooks/webhook-signature-verification)
- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [Get transcription](https://docs.meetstream.ai/api-reference/api-endpoints/transcription/get-transcription)
- [MeetStream transcription provider](https://docs.meetstream.ai/guides/transcription-recordings/providers/meetstream)
- Sibling templates: [transcript-fetcher](../transcript-fetcher), [multi-provider-transcription](../multi-provider-transcription), [webhook-local-tunnel](../webhook-local-tunnel), [ai-meeting-summary](../ai-meeting-summary)
