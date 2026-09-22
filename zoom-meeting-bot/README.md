# Send a Meeting Bot into Zoom with the MeetStream API

Send a MeetStream meeting bot into a Zoom meeting with the MeetStream API, follow its recording and transcription lifecycle over webhooks, and handle the one thing Zoom does that Google Meet and Microsoft Teams do not: **recording is gated on host consent**. Covers the Marketplace app setup, `recording_permission_denied_timeout`, and authenticated ZAK / OBF joins.

## What it does

- `node index.js` validates the config, starts a webhook receiver, calls `POST /bots/create_bot` with a Zoom link and a `callback_url`, then prints every lifecycle event, including the recording-permission outcome, until `bot.done`.
- `node index.js check` validates your config and prints the exact `create_bot` body without calling the API.
- `node index.js listen` runs the webhook receiver on its own.
- Every `automatic_leave` value is range-checked locally, `meeting_captions` is refused up front (not available on Zoom), `create_bot` carries an `Idempotency-Key`, and a `507` replay is treated as success.

## Prerequisites

- Node.js 18 or newer (built-in `fetch`)
- A MeetStream API key from <https://app.meetstream.ai>
- A Zoom Marketplace app connected in the MeetStream dashboard (one time, below)
- A Zoom invite link, including its `?pwd=` component for password-protected meetings
- A publicly reachable webhook URL: `ngrok http 3000`, then put the https origin in `PUBLIC_WEBHOOK_URL`

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/zoom-meeting-bot
npm install
cp .env.example .env      # MEETSTREAM_API_KEY, MEETING_LINK, PUBLIC_WEBHOOK_URL
node index.js check       # validates config, no API call
node index.js
```

## What you should see

`node index.js check` prints `Config is valid. This is the body that would be POSTed to /bots/create_bot (pwd and auth values shown as ***):` followed by the JSON body, and exits 0 without calling the API.

`node index.js` on the happy path (host admits the bot and accepts the recording prompt):

```
Webhook receiver on http://localhost:3000/webhook
callback_url: https://a1b2-203-0-113-0.ngrok-free.app/webhook

Request (pwd and auth values shown as ***):
{
  "meeting_link": "https://zoom.us/j/123456789?pwd=***",
  "bot_name": "MeetStream Notetaker",
  "video_required": false,
  "callback_url": "https://a1b2-203-0-113-0.ngrok-free.app/webhook",
  "automatic_leave": { "recording_permission_denied_timeout": 60 }
}

Bot created.
  bot_id        <bot_id>
  transcript_id (none - no post-call provider set)
  status        Joining

Zoom gates recording on host consent. After bot.inmeeting the bot asks, then waits up to 60s for an answer.

Waiting for webhooks until bot.done (gives up after 330 min; set MAX_SESSION_MINUTES to change).

  <- bot.joining  bot_status=Joining
  <- bot.in_waiting_room  bot_status=InWaitingRoom
     Zoom waiting room. The host has to admit the bot before anything else happens.
  <- bot.inmeeting  bot_status=InMeeting
     In the meeting. On Zoom the bot now asks the host for recording permission, so expect a gap before bot.recording. ...
  <- bot.recording_permission_allowed  bot_status=RecordingPermissionAllowed
     Host granted recording permission.
[INFO ] Zoom host granted recording permission
    bot_id: <bot_id>
  <- bot.recording  bot_status=Recording
     Recording started.
  <- bot.leaving  bot_status=Leaving
  <- bot.stopped  bot_event=bot.stopped  bot_status=Stopped
     Clean exit. bot.done follows as the final event.
[INFO ] Bot finished: Stopped
    bot_id: <bot_id>
    recording_permission: allowed

Post-call processing continues after the bot leaves. Keep listening for audio.processed / transcription.processed / bot.done.
  <- audio.processed  bot_status=Stopped
     post-call: audio.processed
  <- bot.done  bot_status=Stopped
     post-call: bot.done

Pipeline complete. Shutting down.
```

When the host refuses the prompt you get `bot.recording_permission_denied` with `[WARN ] Zoom recording permission was denied` and its `fixes:` line, then `bot.stopped  bot_event=bot.denied`, then `bot.done`, and no recording. If the bot is never admitted, the terminal line is `bot.stopped  bot_event=bot.notallowed`.

`node index.js listen` prints one line per delivery: `<ISO timestamp>  <event>  bot_status=<status>  bot=<bot_id>`.

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `MEETSTREAM_API_KEY` | yes (not for `check` / `listen`) | API key, sent as `Authorization: Token <key>`. |
| `MEETING_LINK` | yes | Full Zoom invite link (`zoom.us`), `?pwd=` included when the meeting has a passcode. |
| `PUBLIC_WEBHOOK_URL` | yes for `node index.js` | Public https origin; `callback_url` = this + `WEBHOOK_PATH`. |
| `PORT` | no | Local webhook port. Default `3000`. |
| `WEBHOOK_PATH` | no | Path the receiver listens on. Default `/webhook`. |
| `WEBHOOK_SECRET` | no | Enables HMAC verification. Per-bot `callback_url` deliveries are not signed; only set this for a workspace endpoint. |
| `NOTIFY_WEBHOOK_URL` | no | Alerts are also POSTed here as JSON. |
| `BOT_NAME` | no | Display name in the meeting. Default `MeetStream Notetaker`. |
| `VIDEO_REQUIRED` | no | Video is off by default; `true` records video as well as audio. Default `false`. |
| `VIDEO_LAYOUT` | no | Only read when `VIDEO_REQUIRED=true`. `speaker_view` (the default) or `grid_view`. The API default is `grid_view`, so speaker view is always sent explicitly. |
| `RECORDING_PERMISSION_DENIED_TIMEOUT` | no | Seconds to wait for the host's recording prompt. Range 60-300, default `60`. Zoom only. |
| `WAITING_ROOM_TIMEOUT` | no | Seconds to wait in the waiting room. Zoom range 60-1200, API default 600. |
| `EVERYONE_LEFT_TIMEOUT` | no | Leave once the count hits zero. Range 60-1800, API default 300. |
| `IN_CALL_RECORDING_TIMEOUT` | no | Hard cap on recording. Range 600-18000, API default 14400. |
| `MAX_SESSION_MINUTES` | no | Local cap: `node index.js` gives up and exits 1 if `bot.done` has not arrived after this many minutes. Default `330`. |
| `TRANSCRIPT_PROVIDER` | no | `deepgram`, `assemblyai`, `sarvam`, `jigsawstack` or `meetstream`. `meeting_captions` is refused on Zoom. Unset means no transcript. |
| `TRANSCRIPT_LANGUAGE` | no | Language for the provider. Default `en`. |
| `RETENTION_HOURS` | no | `recording_config.retention.hours`. Unset means the API default of 720 (30 days). |
| `ZOOM_ZAK_URL` | no | Your https token URL for a signed-in join. Sent as `zoom.zak_url`. |
| `ZOOM_OBF_URL` | no | Your https token URL for an on-behalf-of join. Sent as `zoom.obf_url`. Set at most one of the two. |
| `MEETSTREAM_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |

---

## Zoom app setup (required, one time)

Zoom is the only platform that needs setup before a bot can join. Google Meet and Teams work with zero configuration; Zoom bots join through the Zoom Meeting SDK, which means your own Marketplace app.

1. Create a **General App** in the [Zoom App Marketplace](https://marketplace.zoom.us) (**Develop → Build App → General App**). User-managed or admin-managed both work.
2. Under **Features → Embed**, enable **Meeting SDK**. Leave Device OAuth off.
3. Copy the **Client ID** and **Client Secret** into the MeetStream Dashboard → **Integrations → Zoom**.

These credentials identify the Meeting SDK app the bot runs as. They do not create an end-user OAuth grant; that is only needed for authenticated joins (below), and it runs on your own server.

Full walkthrough with screenshots: [Zoom Marketplace App Setup](https://docs.meetstream.ai/guides/app-integrations/zoom-marketplace-app-setup).

Once that is done, sending a bot is the same single `create_bot` call as any other platform.

### Development mode vs production

| | Development credentials | Production app |
| --- | --- | --- |
| Whose meetings can the bot join? | **Only meetings hosted by your own Zoom account** | Anyone's |
| How do you get there? | Immediately, on app creation | Submit the app for Marketplace review |
| Turnaround | - | Typically a few business days |

If your bot joins your own test meetings fine but fails on a customer's meeting, this is nearly always why. Submission requirements, required scopes, and the common rejection reasons are in [Zoom App Production Submission](https://docs.meetstream.ai/guides/app-integrations/zoom-app-production-submission).

### Authenticated joins (ZAK and OBF)

By default the bot joins as a guest. To join as a signed-in Zoom user, or on behalf of a user who is already in the meeting, pass a token URL that **you** host:

```json
{
  "meeting_link": "https://zoom.us/j/123456789?pwd=...",
  "bot_name": "Notetaker",
  "zoom": { "zak_url": "https://api.yourapp.com/zoom/zak?user_id=alice&auth=YOUR_SECRET" }
}
```

| | `zak_url` | `obf_url` |
| --- | --- | --- |
| Bot joins as | That signed-in Zoom user | An assistant tied to a user in the call |
| Parent must already be in the meeting | No | **Yes**, and Zoom removes the bot if they leave |
| `meeting_number` on your URL | Not needed | **Leave it off**; MeetStream appends it at join |

At join time the bot calls your URL (GET, falling back to POST) and uses the token you return. You run Zoom OAuth and keep the refresh tokens; MeetStream never stores them. Send one URL, never both (400). The old `use_zoom_obf` / `zoom_oauth_connection_user_id` fields are rejected.

Set `ZOOM_ZAK_URL` or `ZOOM_OBF_URL` in `.env` and this template sends the right block. For a working token server, see the [`zoom-authenticated-joins`](../zoom-authenticated-joins) template. Full contract: [Zoom Authenticated Bots](https://docs.meetstream.ai/guides/app-integrations/zoom-authenticated-bots).

---

## The recording permission flow

On Google Meet and Teams, `bot.recording` fires within about a second of `bot.inmeeting`. On Zoom the bot has to **ask the host** first, so there is a visible gap:

```
bot.joining
  -> bot.in_waiting_room        host admits the bot (or waiting_room_timeout fires)
  -> bot.inmeeting              bot now requests recording permission
  -> bot.recording_permission_allowed     host granted
  -> bot.recording              capture starts
  ...
  -> bot.stopped                every ending; bot_event says why
  -> post-call events
  -> bot.done                   final event on every path
```

If the host denies, or simply never answers:

```
  -> bot.inmeeting
  -> bot.recording_permission_denied
  -> bot.leaving
  -> bot.stopped                 reason in bot_event
  -> bot.done
```

Every ending arrives exactly once as `event: "bot.stopped"`, with the reason in `bot_event` (`bot.stopped`, `bot.kicked`, `bot.notallowed`, `bot.denied`, `bot.failed`). `status_code` is 200 for a clean exit or a kick and 500 for `bot.notallowed`, `bot.denied` and most failures. Branch on `bot_event`, not `bot_status`: a kick and a clean exit both report `Stopped`.

That distinction trips people up. `bot_event: "bot.denied"` means a host refused the bot entry or recording; the earlier `bot.recording_permission_denied` event is what tells you the bot got in but was not allowed to **record**, as opposed to being refused at the door. No recording is produced either way, but they are different failures with different fixes.

### `recording_permission_denied_timeout`

```json
{
  "meeting_link": "https://zoom.us/j/123456789?pwd=...",
  "bot_name": "Notetaker",
  "automatic_leave": {
    "recording_permission_denied_timeout": 120
  }
}
```

| | |
| --- | --- |
| Unit | seconds |
| Range | `60` - `300`. Out of range returns **HTTP 400** |
| Default | `60` |
| Platform | **Zoom only.** Ignored on Google Meet and Microsoft Teams |
| On expiry | `bot.recording_permission_denied` → `bot.leaving` → `bot.stopped` |

Sixty seconds is tight for a host who is mid-sentence when the prompt appears. If your bots keep leaving without recording, raising this to 120-180s is usually the cheapest fix. The cost of raising it is bot time spent sitting in a meeting doing nothing.

Things that reduce denials in the first place:

- Tell the host the bot is coming, and what it is called.
- Have the bot's account (or the account that scheduled it) be the meeting host or a co-host - hosts do not have to grant permission to themselves.
- Use the OBF flow so the bot joins as an account the host already trusts.

---

## Other Zoom-specific behaviour

| Behaviour | On Zoom |
| --- | --- |
| Setup | One-time Marketplace app plus dashboard credentials |
| Recording start | Gated on host permission (above) |
| `waiting_room_timeout` | `60`-`1200`s, default `600`. Wider than Google Meet's `60`-`600` |
| Per-participant audio | **Full isolation** - the Zoom SDK gives a dedicated raw PCM stream per participant, so each file contains only that speaker's microphone. The cleanest per-participant audio of any platform |
| Per-participant video | Webcam 640×360 fixed at 300 kbps; screen share at native resolution at 1.5 Mbps; 1 concurrent screen share |
| Screenshots endpoint | Not supported on Zoom bots |
| Native captions (`meeting_captions`) | Not available on Zoom. Use deepgram, assemblyai, sarvam, jigsawstack, or the meetstream engine |
| Chat and images | `send_message` and `send_image` work as on other platforms |

This template refuses to build a `meeting_captions` request for Zoom rather than letting the API reject it.

---

## How it works

```
index.js         config, wiring, run / listen / check commands
src/client.js    fetch wrapper - Token auth, 202 pending, 507 replay, backoff on 429/5xx
src/bot.js       create_bot for Zoom, with range validation on every automatic_leave field
src/events.js    webhook payload -> phase, permission outcome, terminal outcome
src/server.js    express receiver; raw-body capture + optional HMAC verification
src/notify.js    stdout + optional JSON webhook alerts
```

Every `automatic_leave` value is range-checked locally before the request goes out, so you get a clear error instead of a bare HTTP 400. Each create call carries an `Idempotency-Key`, and a `507` reply is treated as success - that status means an idempotent retry hit a request that already completed.

Nothing secret is printed: the `?pwd=` passcode on the meeting link and the `auth=` value on a `zak_url` / `obf_url` are shown as `***` in the printed request body, in `check` output, in error messages and in alert-webhook payloads. The API key is only ever sent in the `Authorization` header.

The receiver acknowledges each delivery with `200` before running the handler. MeetStream does not retry a failed or timed-out delivery, so a slow handler risks losing the event rather than seeing it again.

### Signatures

Deliveries to a per-bot `callback_url` are **not signed**. Signature verification (`X-MeetStream-Signature: sha256=<hex>`, HMAC-SHA256 over the raw body) applies to **workspace webhook endpoints** created in the dashboard. `src/server.js` implements it and turns it on when `WEBHOOK_SECRET` is set - leave it unset for per-bot callbacks.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Configuration error: Missing required environment variable MEETSTREAM_API_KEY` | No `.env` or empty key. | `cp .env.example .env` and paste your key. |
| `PUBLIC_WEBHOOK_URL is required` | No public URL for the receiver. | Run `ngrok http 3000` and paste the https origin. |
| `MEETING_LINK ... does not look like a Zoom link` | The link is not on a `zoom.us` host. | Paste the full invite link. |
| `MeetStream 401` / `403` | No key sent, or the key is not valid for this workspace. If the key is right, the Zoom credentials may not be connected. | Check the key; confirm Dashboard > Integrations > Zoom shows the Marketplace app. |
| `MeetStream 400` from `create_bot` | Out-of-range `automatic_leave` value (`recording_permission_denied_timeout` 60-300, `waiting_room_timeout` 60-1200, `in_call_recording_timeout` at least 600), both `zak_url` and `obf_url` sent, or a malformed link. | Fix the value; send one token URL at most. |
| `MeetStream 507` | Idempotent replay of an earlier `create_bot`. | Nothing to fix; the original bot is returned. |
| Bot joins but never records | The host never granted permission: watch for `bot.recording_permission_allowed` / `_denied`. | Ask the host to accept the prompt; raise `RECORDING_PERMISSION_DENIED_TIMEOUT` (max 300). |
| Bot can only join my own meetings | Your Marketplace app is still in development mode. | Submit it for production approval. |
| Bot never gets in at all | The link is invalid or expired, `?pwd=` is missing, the app is in development mode for someone else's meeting, or the bot sat in the waiting room until `waiting_room_timeout` fired (`bot.stopped` with `bot_event: "bot.notallowed"`). | Check each in that order. |
| `bot_event: "bot.denied"` | The host refused the bot entry or recording. | Tell the host the bot is coming; make the bot's account a co-host. |
| OBF joins suddenly fail for one user | Their connection was revoked: a Zoom password change, uninstalling the app, or 90+ days idle. | They need to reconnect through your token server. |
| `Port 3000 is already in use` | Another process owns the port. | Set `PORT` to a free port and update the tunnel. |
| `Configuration error: ... must be between <min> and <max>` / `meeting_captions is not available on Zoom` / `Set only one of ZOOM_ZAK_URL or ZOOM_OBF_URL` | A value in `.env` failed the local range or combination check (nothing was sent). | Fix the value; see the Environment variables table for ranges. |
| `MeetStream 404 on /bots/create_bot` | `MEETSTREAM_BASE_URL` points at the wrong base, or the path was changed. | Use `https://api.meetstream.ai/api/v1`. |
| `MeetStream 429` / `500` / `502` / `503` / `504` after a few seconds | Rate limit or transient server error; the client retried 3 times with backoff and gave up. | Wait a minute and run again. |
| `Network error calling POST /bots/create_bot` | DNS, connection or 30 s timeout failure, retried 3 times. | Check connectivity and `MEETSTREAM_BASE_URL`. |
| `WARN  No bot.inmeeting and no bot.stopped after N min` | The bot is stuck, or webhooks are not reaching `PUBLIC_WEBHOOK_URL`. | `curl <PUBLIC_WEBHOOK_URL>/healthz` through the tunnel; check `GET /bots/{bot_id}/status`. |
| `Gave up waiting for bot.done after N minutes` (exit 1) | `bot.done` never arrived within `MAX_SESSION_MINUTES`: a lost delivery (they are not retried) or a very long meeting. | Check `GET /bots/{bot_id}/detail` for the media; raise `MAX_SESSION_MINUTES` for long sessions. |
| `Rejected a webhook delivery: bad or missing signature.` | `WEBHOOK_SECRET` is set but the delivery came to a per-bot `callback_url`, which is never signed. | Unset `WEBHOOK_SECRET` for per-bot callbacks; use it only on a workspace endpoint. |
| `Webhook handler threw: ...` | The handler crashed on one payload; the delivery was already acknowledged with 200. | Read the stack trace; the event is not redelivered. |
| `(notify webhook returned HTTP ...)` / `(notify webhook failed: ...)` | `NOTIFY_WEBHOOK_URL` is unreachable or rejecting the JSON. | Fix or unset it; alerts still print to stdout. |
| `{"message":"No handler for POST /..."}` in the tunnel log | `callback_url` path does not match `WEBHOOK_PATH`. | Keep them in sync; the default is `/webhook`. |

---

## Related

- [Zoom meeting bots](https://docs.meetstream.ai/guides/platforms/zoom)
- [Zoom Marketplace app setup](https://docs.meetstream.ai/guides/app-integrations/zoom-marketplace-app-setup)
- [Zoom app production submission](https://docs.meetstream.ai/guides/app-integrations/zoom-app-production-submission)
- [Zoom authenticated bots](https://docs.meetstream.ai/guides/app-integrations/zoom-authenticated-bots)
- [Automatic leave configuration](https://docs.meetstream.ai/guides/features/automatic-leave-configuration)
- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [Error reference](https://docs.meetstream.ai/errors)
- Templates: [zoom-authenticated-joins](../zoom-authenticated-joins/README.md), [teams-meeting-bot](../teams-meeting-bot/README.md), [webhook-handler-complete](../webhook-handler-complete/README.md), [gmeet-lobby-handling](../gmeet-lobby-handling/README.md)
