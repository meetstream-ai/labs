# AI Meeting Notetaker to Email

A MeetStream bot joins your meeting, records and transcribes it, MeetStream generates the AI summary, and this script emails the notes to the attendees.

```bash
npm install
cp .env.example .env    # fill in MEETSTREAM_API_KEY and your email provider
node index.js --meeting "https://meet.google.com/abc-defg-hij"
```

## What it does

1. `POST /bots/create_bot` with your `meeting_link` and a `callback_url`.
2. Serves a webhook and follows the bot lifecycle to `transcription.processed`.
3. Fetches the transcript with `GET /transcript/{transcript_id}/get_transcript`.
4. Pulls MeetStream's AI summary from `GET /bots/{bot_id}/summary`.
5. Pulls the attendee list from `GET /bots/{bot_id}/get_participants`.
6. Renders an HTML + plain-text email and sends it through Resend, SendGrid, SMTP, or the console.

## Prerequisites

- Node 18 or newer (built-in `fetch`, ESM).
- A MeetStream API key from <https://app.meetstream.ai>.
- One of: a Resend API key, a SendGrid API key, SMTP credentials, or nothing at all if you just want `EMAIL_PROVIDER=console`.
- For live mode, a public HTTPS URL that MeetStream can reach. In development, run a tunnel:
  ```bash
  ngrok http 3000
  # or
  cloudflared tunnel --url http://localhost:3000
  ```
  and put the resulting HTTPS URL in `PUBLIC_BASE_URL`.

## Setup

```bash
npm install
cp .env.example .env
```

Then edit `.env`. The only always-required value is `MEETSTREAM_API_KEY`. Start with `EMAIL_PROVIDER=console` to watch the whole pipeline run without sending anything.

## Run

Live mode, joins a meeting and waits for it to end:

```bash
node index.js --meeting "https://meet.google.com/abc-defg-hij"
```

Replay mode, runs against a meeting that already finished. This is the fast way to iterate on the email template:

```bash
node index.js --bot 8f2c1a3e-...            # looks up transcript_id for you
node index.js --transcript 4b71d0ca-...     # if you already have it
```

## Choosing an email provider

Set `EMAIL_PROVIDER` to one of:

| Value | Needs | Notes |
|---|---|---|
| `console` | nothing | Prints the email to stdout. The default, and the right starting point. |
| `resend` | `RESEND_API_KEY`, `EMAIL_FROM` | Plain HTTPS call to `api.resend.com`, no SDK. The `EMAIL_FROM` domain must be verified in Resend. |
| `sendgrid` | `SENDGRID_API_KEY`, `EMAIL_FROM` | Plain HTTPS call to `api.sendgrid.com/v3/mail/send`. SendGrid returns `202 Accepted` with an empty body on success. |
| `smtp` | `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | Uses `nodemailer`, loaded lazily so the other providers do not pay for it. Port 465 implies implicit TLS; anything else uses STARTTLS. Override with `SMTP_SECURE`. |

Recipients come from `EMAIL_TO` (comma separated). Set `SEND_TO_PARTICIPANTS=true` to also email everyone the meeting platform reported, when it exposes their addresses. Keep `EMAIL_TO` populated as a fallback, because Zoom, Meet and Teams do not always expose attendee emails.

Adding a provider is a single function in `src/email.js` plus a case in the switch.

## How it works

```
index.js          preflight config, then the business logic for this template
src/pipeline.js   create the bot, serve the webhook, fetch the transcript
src/meetstream.js the MeetStream API client
src/email.js      pluggable email delivery
src/render.js     HTML + plain-text email bodies
```

The MeetStream details that matter:

- Auth is `Authorization: Token <key>`. The literal word `Token`, not `Bearer`.
- The create field is `meeting_link`, not `meeting_url`, and `video_required` is a boolean.
- The webhook envelope key is `event`. The lifecycle is `bot.joining` to `bot.in_waiting_room` to `bot.inmeeting` to `bot.recording` to `bot.leaving` to `bot.stopped` to `manifest.completed` to `audio.processed` to `transcription.processed` to `video.processed` to `bot.done`.
- `bot.stopped` always carries `status_code: 200`. The `bot_status` field tells you why it stopped: `Stopped` is normal, `NotAllowed` is a lobby timeout, `Denied` means the host refused, `Error` is an internal failure.
- Webhooks never include `transcript_id`. It comes from the `create_bot` response, or from `GET /bots/{id}/detail`, or from `GET /bots/{id}/transcriptions`.
- The transcript is fetched by **transcript_id**, not bot_id.
- Transcript segments carry their text in a field called `transcript`, not `text`.
- `HTTP 202` on `get_transcript` means "still processing, poll again". The polling is capped.
- `HTTP 507` is an idempotent replay of a request you already made. The client treats it as success.

## Troubleshooting

**`get_transcript` keeps returning 202 until the retry cap.**
The bot was probably created with a streaming-only provider. `deepgram_streaming`, `assemblyai_streaming`, `jigsawstack_streaming`, `meetstream_streaming` and `meeting_captions` never write a post-call transcript. Set `TRANSCRIPT_PROVIDER` to a post-call provider such as `meetstream` or `deepgram`.

**`transcript_id` came back `null` from `create_bot`.**
Same cause. `meeting_captions` in particular always returns `null`.

**No webhook events arrive.**
`PUBLIC_BASE_URL` must be a public HTTPS URL, and your tunnel must point at the same `PORT` the script is listening on. Check `GET /health` through the tunnel first.

**`bot.stopped` with `bot_status: NotAllowed`.**
Nobody admitted the bot from the waiting room before the timeout. Admit it faster, or raise `automatic_leave.waiting_room_timeout`.

**HTTP 403 from MeetStream.**
The API key is present but wrong. 401 means no key at all was sent.

**The summary is empty.**
`GET /bots/{id}/summary` returns `202` while it is still generating. Re-run in replay mode a minute later: `node index.js --bot <bot_id>`.

**Resend rejects the send.**
The `EMAIL_FROM` domain has to be verified in your Resend account. Unverified domains fail with a 403.
