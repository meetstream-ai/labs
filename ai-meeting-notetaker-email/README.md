# Email AI Meeting Notes and Transcripts with the MeetStream API

A MeetStream API meeting bot joins your Zoom, Google Meet or Microsoft Teams meeting, records and transcribes it, and MeetStream generates the AI summary. This script then emails the summary and transcript to the attendees through Resend, SendGrid or SMTP, driven by webhooks so nothing is polled blindly.

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
git clone https://github.com/meetstream-ai/labs.git
cd labs/ai-meeting-notetaker-email
npm install
cp .env.example .env
```

Then edit `.env`. The only always-required value is `MEETSTREAM_API_KEY`. Start with `EMAIL_PROVIDER=console` to watch the whole pipeline run without sending anything.

## Environment variables

| Name | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | API key from <https://app.meetstream.ai>. Sent as `Authorization: Token <key>`. |
| `MEETSTREAM_BASE_URL` | no | API base URL. Default `https://api.meetstream.ai/api/v1`. |
| `MEETING_LINK` | live mode | Zoom, Google Meet or Teams URL. `--meeting` overrides it. |
| `BOT_NAME` | no | Display name in the meeting. Default `MeetStream Labs Bot`. |
| `TRANSCRIPT_PROVIDER` | no | Post-call provider: `meetstream`, `deepgram`, `assemblyai`, `sarvam`, `jigsawstack`. Default `meetstream`. Never a `*_streaming` provider. |
| `TRANSCRIPT_LANGUAGE` | no | Transcription language code. Default `en`. |
| `RETENTION_HOURS` | no | Delete the recording after N hours. Default is the API default, 720 (30 days). |
| `PUBLIC_BASE_URL` | live mode | Public HTTPS URL of this server; the bot's `callback_url` is `${PUBLIC_BASE_URL}/webhook`. `--public-url` overrides it. |
| `PORT` | no | Local webhook port. Default `3000`. |
| `TRANSCRIPT_POLL_ATTEMPTS` | no | Max `get_transcript` polls while it returns 202. Default `20`. |
| `TRANSCRIPT_POLL_INTERVAL_MS` | no | Delay between polls. Default `5000`. |
| `BOT_ID` | replay | Replay a finished meeting by bot id. Same as `--bot`. |
| `TRANSCRIPT_ID` | replay | Replay a known transcript id. Same as `--transcript`. |
| `EMAIL_PROVIDER` | no | `console`, `resend`, `sendgrid` or `smtp`. Default `console`. |
| `EMAIL_FROM` | all but console | Sender address. |
| `EMAIL_TO` | yes* | Comma-separated recipients. *Optional only when `SEND_TO_PARTICIPANTS=true`. |
| `SEND_TO_PARTICIPANTS` | no | `true` also emails attendees whose addresses the platform exposed. Default `false`. |
| `EMAIL_SUBJECT` | no | `{date}` is replaced with today's date. Default `Meeting notes - {date}`. |
| `TRANSCRIPT_EXCERPT_TURNS` | no | Speaker turns inlined in the email body. Default `40`. |
| `RESEND_API_KEY` | resend | Resend API key. |
| `SENDGRID_API_KEY` | sendgrid | SendGrid API key. |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` | smtp | SMTP server and credentials. |
| `SMTP_PORT` | no | Default `587`. |
| `SMTP_SECURE` | no | `true` forces implicit TLS. Default: inferred from the port (465 = true). |

**Recording defaults.** This template records audio only: it sends `video_required: false` explicitly, because the REST API treats an omitted `video_required` as true. If you turn video on in code, it sends `recording_config.video_layout: "speaker_view"` (the API default is `grid_view`, so speaker view has to be explicit); use `grid_view` only when you want the composited mosaic of everyone. Per-participant video (`video_separate_streams`) is never enabled implicitly.

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
- Every webhook carries `event`; most also carry `bot_event` with the specific name, so read `bot_event ?? event`. The typical lifecycle is `bot.joining` to `bot.in_waiting_room` to `bot.inmeeting` to `bot.recording` to `bot.leaving` to `bot.stopped` to `manifest.completed` / `audio.processed` to `transcription.processed` to `bot.transcriptionready` to `video.processed` to `bot.done`. `bot.done` is the final event on every path.
- Every ending arrives as `event: "bot.stopped"`, and `bot_event` gives the reason: `bot.stopped` (clean exit, 200), `bot.kicked` (a participant removed the bot, 200), `bot.notallowed` (lobby timeout, 500), `bot.denied` (host refused, 500), `bot.failed` (crashed, usually 500). Branch on `bot_event`, not `bot_status`: a kick and a clean exit both report `Stopped`. The pipeline falls back to `bot_status` (case-insensitive) only when `bot_event` is missing. A kick still continues to the transcript; the other non-clean reasons exit.
- If `bot.done` arrives without a `transcription.processed` before it, there is no post-call transcript and the pipeline exits instead of waiting forever.
- Webhooks never include `transcript_id`. It comes from the `create_bot` response, or from `GET /bots/{id}/detail`, or from `GET /bots/{id}/transcriptions`.
- The transcript is fetched by **transcript_id**, not bot_id.
- Transcript segments carry their text in a field called `transcript`, not `text`.
- `HTTP 202` on `get_transcript` means "still processing, poll again". The polling is capped.
- `HTTP 507` is an idempotent replay of a request you already made. The client treats it as success.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing required environment variable: MEETSTREAM_API_KEY` | `.env` not created or key blank | `cp .env.example .env` and fill in the key. |
| HTTP 401 from MeetStream | No `Authorization` header was sent | Check `.env` is loaded and the key is not empty. |
| HTTP 403 from MeetStream | Key present but wrong, or from another workspace | Regenerate the key in the dashboard. |
| `get_transcript` returns 202 until the retry cap | Bot was created with a streaming-only provider (`*_streaming`, `meeting_captions`); those never write a post-call transcript | Set `TRANSCRIPT_PROVIDER` to `meetstream`, `deepgram`, `assemblyai`, `sarvam` or `jigsawstack`. |
| `transcript_id` is `null` from `create_bot` | Same cause; `meeting_captions` always returns `null` | Same fix. |
| No webhook events arrive | `PUBLIC_BASE_URL` is not public HTTPS, or the tunnel points at a different port | Hit `GET /health` through the tunnel, then match `PORT`. |
| `bot.stopped` with `bot_event: bot.notallowed` (status_code 500) | Nobody admitted the bot before the waiting-room timeout | Admit it sooner, or raise `automatic_leave.waiting_room_timeout`. |
| `bot.stopped` with `bot_event: bot.denied` | Host refused entry or recording | Ask the host to allow the bot; see the platform guides. |
| `bot.done` arrived with no `transcription.processed` | No post-call transcript exists for this bot | The pipeline exits; re-check the provider. |
| Summary is empty | `GET /bots/{id}/summary` returns 202 while generating | Re-run in replay mode a minute later: `node index.js --bot <bot_id>`. |
| HTTP 429 | Rate limited | The client retries with backoff; slow down concurrent runs. |
| HTTP 507 | Idempotent replay of a request already made | Treated as success; the existing bot is reused. |
| Resend rejects the send (403) | `EMAIL_FROM` domain not verified in Resend | Verify the domain in your Resend account. |

## Related

- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [Get transcription](https://docs.meetstream.ai/api-reference/api-endpoints/transcription/get-transcription)
- [Get bot summary](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-summary)
- [Fetch participants](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/fetch-participants)
- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Post-call transcription](https://docs.meetstream.ai/guides/transcription-recordings/post-call-transcription)
- [Error codes](https://docs.meetstream.ai/errors)
- Labs: [ai-meeting-summary](../ai-meeting-summary), [transcript-fetcher](../transcript-fetcher), [webhook-handler-complete](../webhook-handler-complete)
