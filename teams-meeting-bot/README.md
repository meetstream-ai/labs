# Send a Meeting Bot into Microsoft Teams with the MeetStream API

Send a MeetStream meeting bot into a Microsoft Teams meeting with the MeetStream API, follow its recording and transcription lifecycle over webhooks, and understand what Teams does differently from Zoom and Google Meet: lobby admission, timeouts, native captions and signed-in bots.

## What it does

- `node index.js` validates the config, starts a webhook receiver, calls `POST /bots/create_bot` with a Teams link and a `callback_url`, then prints every lifecycle event until `bot.done`.
- `node index.js check` validates your config and prints the exact `create_bot` body without calling the API.
- `node index.js listen` runs the webhook receiver on its own.
- Every `automatic_leave` value is range-checked locally, `create_bot` carries an `Idempotency-Key`, and a `507` replay is treated as success.

## Prerequisites

- Node.js 18 or newer (built-in `fetch`)
- A MeetStream API key from <https://app.meetstream.ai>
- A Microsoft Teams meeting join link, exactly as it appears in the invite
- A publicly reachable webhook URL: `ngrok http 3000`, then put the https origin in `PUBLIC_WEBHOOK_URL`

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/teams-meeting-bot
npm install
cp .env.example .env      # MEETSTREAM_API_KEY, MEETING_LINK, PUBLIC_WEBHOOK_URL
node index.js check       # validates config, no API call
node index.js
```

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `MEETSTREAM_API_KEY` | yes (not for `check` / `listen`) | API key, sent as `Authorization: Token <key>`. |
| `MEETING_LINK` | yes | Teams join link (`teams.microsoft.com` or `teams.live.com`). |
| `PUBLIC_WEBHOOK_URL` | yes for `node index.js` | Public https origin; `callback_url` = this + `WEBHOOK_PATH`. |
| `PORT` | no | Local webhook port. Default `3000`. |
| `WEBHOOK_PATH` | no | Path the receiver listens on. Default `/webhook`. |
| `WEBHOOK_SECRET` | no | Enables HMAC verification. Per-bot `callback_url` deliveries are not signed; only set this for a workspace endpoint. |
| `NOTIFY_WEBHOOK_URL` | no | Alerts are also POSTed here as JSON. |
| `BOT_NAME` | no | Display name in the meeting. Default `MeetStream Notetaker`. |
| `VIDEO_REQUIRED` | no | Record video as well as audio. Default `false`. |
| `JOIN_AT` | no | ISO 8601 time to join later; sets `join_at`. |
| `WAITING_ROOM_TIMEOUT` | no | Seconds to wait for admission. Teams range 60-1800, API default 600. |
| `NO_ONE_JOINED_TIMEOUT` | no | Leave if nobody joins. Range 60-1800, API default 600. |
| `EVERYONE_LEFT_TIMEOUT` | no | Leave once the count hits zero. Range 60-1800, API default 300. |
| `VOICE_INACTIVITY_TIMEOUT` | no | Leave after a stretch of silence. Range 60-1800. |
| `IN_CALL_RECORDING_TIMEOUT` | no | Hard cap on recording. Range 600-18000, API default 14400. |
| `TRANSCRIPT_PROVIDER` | no | `deepgram`, `assemblyai`, `sarvam`, `jigsawstack`, `meetstream` or `meeting_captions`. Unset means no transcript. |
| `TRANSCRIPT_LANGUAGE` | no | Language for the provider. Default `en`. |
| `RETENTION_HOURS` | no | `recording_config.retention.hours`. Unset means the API default of 720 (30 days). |
| `MEETSTREAM_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |

---

## Joining a Teams meeting

Teams needs **no setup**. There is no app registration, no marketplace submission, no credentials to paste into a dashboard. Pass a Teams meeting link to `create_bot` and the bot joins:

```bash
curl -X POST "https://api.meetstream.ai/api/v1/bots/create_bot" \
  -H "Authorization: Token <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "meeting_link": "https://teams.microsoft.com/l/meetup-join/...",
    "bot_name": "Notetaker"
  }'
```

The platform is inferred from the link, so a guest join needs no Teams-specific fields. Use the join URL exactly as it appears in the invite; do not trim its query string. To join as a signed-in Microsoft 365 account instead of a guest, pass a `teams` block (`{ "login_required": true, "teams_login_domain": "bots.acme.com" }`) after registering the domain and accounts; see [teams-signed-in-bots-setup](../teams-signed-in-bots-setup).

Azure app registration is only needed for the **Outlook Calendar** integration (auto-joining scheduled meetings), never for sending a bot at a link you already have.

---

## Lobby and admission

Teams meetings can hold a joining participant in a lobby, and MeetStream reports that as `bot.in_waiting_room` with `bot_status: "InWaitingRoom"`. Whether the bot waits at all, and who is allowed to admit it, is decided by the meeting's own Teams admission policy - MeetStream can request access and report what happens, it cannot override the organiser's settings or the tenant's policy.

What is documented and dependable:

- **`waiting_room_timeout`** controls how long the bot waits. On Teams the range is `60`-`1800` seconds, default `600`. Out of range returns HTTP 400.
- If the timeout elapses without admission, you get `bot.stopped` with **`bot_event: "bot.notallowed"`** (`status_code: 500`, `bot_status: "NotAllowed"`), then `bot.done`.
- If someone explicitly rejects the request, you get `bot.stopped` with **`bot_event: "bot.denied"`** (`status_code: 500`, `bot_status: "Denied"`), then `bot.done`.
- The Teams timeout defaults are deliberately higher than elsewhere because Teams lobbies and meeting starts can run slower: `waiting_room_timeout` 600, `no_one_joined_timeout` 600, `everyone_left_timeout` 300.

Beyond that, the precise admission rules - who counts as an organiser, which tenant policies bypass the lobby, how guest and federated users are treated - are Microsoft's behaviour and vary by tenant configuration. If a bot is not being admitted in your environment, check the meeting's lobby settings in Teams and Microsoft's own documentation, and see [Debugging Bots](https://docs.meetstream.ai/guides/help/debugging-bots) for how to read what MeetStream observed.

---

## What differs from Zoom and Google Meet

| Behaviour | Teams | Zoom | Google Meet |
| --- | --- | --- | --- |
| Setup | None | One-time Marketplace app + dashboard credentials | None |
| Recording start | On the first audio frame, typically within about a second of `bot.inmeeting` - no permission gate | **Gated on host consent** (`bot.recording_permission_allowed` / `_denied`) | Immediately after joining, no gate |
| `waiting_room_timeout` range | 60-1800 (default 600) | 60-1200 (default 600) | 60-600 (default 600) |
| Other timeout defaults | `no_one_joined_timeout` 600, `everyone_left_timeout` 300 | - | `no_one_joined_timeout` 600, `everyone_left_timeout` 300 |
| `recording_permission_denied_timeout` | Ignored | 60-300, default 60 | Ignored |
| Signed-in / authenticated bot identity | `teams.login_required` with a registered `teams_login_domain` (Microsoft 365 work/school accounts, one concurrent bot per account; the bot uses the account's own display name): see [`teams-signed-in-bots-setup`](../teams-signed-in-bots-setup) | `zoom.zak_url` (as a signed-in user) or `zoom.obf_url` (on behalf of a user in the call), minted by your own server: see [`zoom-authenticated-joins`](../zoom-authenticated-joins) | `google_meet.login_required` signed-in bots |
| Per-participant audio | Partial isolation - speaker-attributed capture via the browser bot, same stream-capture model as Google Meet | **Full isolation** - dedicated raw PCM stream per participant | Partial isolation, up to 3 concurrent speaker streams |
| Per-participant video | Webcam up to 854×480 @ 800 kbps; screen share up to 1280×720 @ 2 Mbps; 1 concurrent screen share | Webcam 640×360 fixed @ 300 kbps; screen share at native resolution @ 1.5 Mbps; 1 concurrent | Webcam up to 854×480 @ 800 kbps; screen share up to 1280×720 @ 2 Mbps; **multiple** concurrent screen shares |
| Video segmenting | A webcam dimension change starts a new segment (as does a screen-share resolution change) | - | - |
| Native captions (`meeting_captions`) | Supported | **Not available** | Supported |
| Screenshots endpoint | - | Not supported on Zoom | - |
| Calendar auto-join | Outlook Calendar (Azure app registration) | - | Google Calendar OAuth |

The single biggest practical difference: **Zoom makes you wait for host consent before recording, Teams and Meet do not.** If you are porting Zoom-shaped code to Teams, the `bot.recording_permission_*` branch simply never fires.

`automatic_leave.bot_detection` also works on Teams - the bot identifies itself by its stable bot ID as soon as its websocket connects. See the [automatic leave guide](https://docs.meetstream.ai/guides/features/automatic-leave-configuration).

---

## Transcription on Teams

Every provider works the same as elsewhere. Pick exactly one key under `recording_config.transcript.provider`:

| Provider | Notes |
| --- | --- |
| `deepgram`, `assemblyai`, `sarvam`, `jigsawstack`, `meetstream` | Post-call. The create response returns a `transcript_id`; wait for `transcription.processed`, then `GET /transcript/{transcript_id}/get_transcript` |
| `meeting_captions` | Teams' own native captions. **No separate transcript resource**, so `transcript_id` comes back `null` |

Set `TRANSCRIPT_PROVIDER` in `.env`. Transcript segments use `speaker` and **`transcript`** fields - not `text`. Fetching is `HTTP 202` until it is ready, so poll with a cap.

## Outlook Calendar auto-join

Teams meetings usually live on Outlook calendars. MeetStream connects one via `POST /calendar/create_outlook_calendar` with an Azure app registration (Microsoft Graph permissions), then syncs events, detects Teams links (`meeting_platform: "Teams"`), and schedules bots. Microsoft Graph change notifications are auto-renewed, and you can hold up to 200 calendar connections per user across Google and Outlook combined.

That is out of scope for this template - see [Outlook Calendar Setup](https://docs.meetstream.ai/guides/calendar-integrations/outlook-calendar-setup) and the [Scheduling guide](https://docs.meetstream.ai/guides/features/scheduling-bots). For a one-off future join, this template supports `JOIN_AT` (ISO 8601), which sets `join_at` on `create_bot`.

---

## The lifecycle you will see

```
bot.joining
  -> bot.in_waiting_room      may be brief or long, depending on the lobby policy
  -> bot.inmeeting
  -> bot.recording            typically within ~1s - this template prints the gap
  -> bot.leaving
  -> bot.stopped              every ending; bot_event says why
  -> manifest.completed / audio.processed / transcription.processed / video.processed
  -> bot.done                 final event on every path
  -> data_deletion            when retention expires or you delete the data
```

`event` is always present and is the generic name. `bot_event` is the specific name, equal to `event` on everything except terminals:

```json
{
  "bot_id": "a29d00c3-...",
  "event": "bot.inmeeting",
  "bot_event": "bot.inmeeting",
  "bot_status": "InMeeting",
  "message": "...",
  "status_code": 200,
  "custom_attributes": {},
  "timestamp": "2026-08-09T07:16:44.675Z"
}
```

Every ending arrives exactly once as `event: "bot.stopped"`, and `bot_event` carries the reason:

| `bot_event` | `status_code` | `bot_status` |
| --- | --- | --- |
| `bot.stopped` | 200 | `Stopped` |
| `bot.kicked` | 200 | `Stopped` |
| `bot.notallowed` | 500 | `NotAllowed` |
| `bot.denied` | 500 | `Denied` |
| `bot.failed` | usually 500 | `FAILED` / `ERROR` / `Failed` |

`src/lifecycle.js` detects the terminal from `event` and **branches on `bot_event`**, not `bot_status`: a kick and a clean exit both say `Stopped`, and the failure casing varies. `bot_status` is only a case-insensitive fallback if `bot_event` is missing.

`bot.done` is the final event on every path, including streaming-only providers (which never send `transcription.processed`) and bots that were never admitted. `audio.processed` is never final. That is why this template waits for `bot.done` before shutting down.

---

## How it works

```
index.js          config, wiring, run / listen / check commands
src/client.js     fetch wrapper - Token auth, 202 pending, 507 replay, backoff on 429/5xx
src/bot.js        create_bot for Teams, with range validation on every automatic_leave field
src/lifecycle.js  webhook payload -> phase, terminal outcome, plain-English note
src/server.js     express receiver; raw-body capture + optional HMAC verification
src/notify.js     stdout + optional JSON webhook alerts
```

Timeouts are range-checked locally before the request goes out, so you get a clear error instead of a bare HTTP 400. Each create call carries an `Idempotency-Key`, and `507` is treated as success - that status means an idempotent retry hit a request that already completed.

Deliveries to a per-bot `callback_url` are **not signed**; signature verification applies to workspace webhook endpoints created in the dashboard. `src/server.js` implements it (HMAC-SHA256 over the raw body, `X-MeetStream-Signature: sha256=<hex>`) and enables it when `WEBHOOK_SECRET` is set.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Configuration error: Missing required environment variable MEETSTREAM_API_KEY` | No `.env` or empty key. | `cp .env.example .env` and paste your key. |
| `PUBLIC_WEBHOOK_URL is required` | No public URL for the receiver. | Run `ngrok http 3000` and paste the https origin. |
| `MEETSTREAM_LINK ... does not look like a Microsoft Teams link` | The link is not on `teams.microsoft.com` / `teams.live.com`. | Copy the join URL from the invite, query string included. |
| `MeetStream 401` / `403` | No key sent, or the key was rejected. | Check the key is complete and active for this workspace. |
| `MeetStream 400` from `create_bot` | Out-of-range `automatic_leave` value (`waiting_room_timeout` 60-1800 on Teams, `in_call_recording_timeout` at least 600), a malformed link, or an unregistered `teams_login_domain`. | Fix the value; register the domain first for signed-in bots. |
| `MeetStream 409` / `429` on a signed-in join | The pinned account is busy, or every account in the domain is in use. | Register more accounts, or set `strict_email: false`. |
| Bot sits in the lobby and is never admitted | The run ends with `bot.stopped` / `bot_event: "bot.notallowed"`, then `bot.done`. | Someone with admission rights has to let it in; raise `WAITING_ROOM_TIMEOUT` (up to 1800) if the bot arrives before anyone else. |
| `bot_event: "bot.denied"` | Someone explicitly rejected the join request. | Ask the organiser to admit the bot next time. |
| `MeetStream 507` | Idempotent replay of an earlier `create_bot`. | Nothing to fix; the original bot is returned. |
| `transcript_id` is null | Expected with `meeting_captions`, or with no post-call provider at all. | Set a post-call `TRANSCRIPT_PROVIDER` if you need a transcript resource. |
| A participant's video split into several files | On Teams a webcam dimension change (or a screen-share resolution change) starts a new segment. | Segments are chronologically ordered with `segment_index`. |
| Nothing arrives at the webhook | `PUBLIC_WEBHOOK_URL` is not reachable from the internet. | Check the tunnel and the printed `callback_url`; `GET /healthz` confirms the server is up. |
| `Port 3000 is already in use` | Another process owns the port. | Set `PORT` to a free port and update the tunnel. |

---

## Related

- [Microsoft Teams bots](https://docs.meetstream.ai/guides/platforms/microsoft-teams)
- [Teams signed-in bots](https://docs.meetstream.ai/guides/app-integrations/teams-signed-in-bots)
- [Automatic leave configuration](https://docs.meetstream.ai/guides/features/automatic-leave-configuration)
- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Webhook signature verification](https://docs.meetstream.ai/guides/webhooks/webhook-signature-verification)
- [Outlook Calendar setup](https://docs.meetstream.ai/guides/calendar-integrations/outlook-calendar-setup)
- [Per-participant audio](https://docs.meetstream.ai/guides/transcription-recordings/per-participant-audio) and [video](https://docs.meetstream.ai/guides/transcription-recordings/per-participant-video)
- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [Debugging bots](https://docs.meetstream.ai/guides/help/debugging-bots)
- Templates: [teams-signed-in-bots-setup](../teams-signed-in-bots-setup/README.md), [zoom-meeting-bot](../zoom-meeting-bot/README.md), [outlook-calendar-integration](../outlook-calendar-integration/README.md), [webhook-handler-complete](../webhook-handler-complete/README.md)
