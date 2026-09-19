# Handle the Google Meet Waiting Room for MeetStream Bots

Send a MeetStream API meeting bot into a Google Meet, watch what the waiting room does to it over webhooks, and react: nudge a human while it waits, retry when the lobby times out (`bot.notallowed`), and stop cleanly when a host denies it (`bot.denied`). Google Meet only; the same webhook model applies to Zoom and Microsoft Teams but their lobby rules differ.

```bash
npm install
cp .env.example .env      # MEETSTREAM_API_KEY, MEETING_LINK, PUBLIC_WEBHOOK_URL
node index.js
```

You need a publicly reachable webhook URL. In another terminal: `ngrok http 3000`, then put the https origin in `PUBLIC_WEBHOOK_URL`.

Want to watch events without creating a bot? `node index.js listen`.

## Prerequisites

- Node.js 18 or newer.
- A MeetStream API key from <https://app.meetstream.ai>.
- A Google Meet link you can host or get admitted to.
- A public HTTPS tunnel to this machine (`ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000`).

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/gmeet-lobby-handling
npm install
cp .env.example .env
ngrok http 3000            # in another terminal; paste the https origin into PUBLIC_WEBHOOK_URL
node index.js
```

## Environment variables

| Name | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>`. |
| `MEETSTREAM_BASE_URL` | no | API base URL. Default `https://api.meetstream.ai/api/v1`. |
| `MEETING_LINK` | yes | The `meet.google.com` link to join. |
| `BOT_NAME` | no | Display name for anonymous bots. Default `MeetStream Notetaker`. Ignored for signed-in bots. |
| `VIDEO_REQUIRED` | no | Record video as well as audio. Default `false`. |
| `PORT` | no | Local port for the webhook receiver. Default `3000`. |
| `WEBHOOK_PATH` | no | Path the receiver listens on. Default `/webhook`. |
| `PUBLIC_WEBHOOK_URL` | yes | Public HTTPS origin of this server; `callback_url` is `PUBLIC_WEBHOOK_URL + WEBHOOK_PATH`. |
| `WEBHOOK_SECRET` | no | HMAC secret. Only for workspace webhook endpoints; per-bot `callback_url` deliveries are not signed. |
| `NOTIFY_WEBHOOK_URL` | no | Alerts are POSTed here as JSON in addition to stdout. |
| `WAITING_ROOM_TIMEOUT` | no | Seconds to wait for admission, 60-600. Default `300`. |
| `LOBBY_ALERT_SECONDS` | no | Nudge a human after this many seconds in the lobby. `0` disables. Default `60`. |
| `MAX_JOIN_ATTEMPTS` | no | Total sends on lobby timeout, 1-5. Default `2`. |
| `RETRY_DELAY_SECONDS` | no | Wait before re-sending after a timeout. Default `30`. |
| `RETRY_TIMEOUT_ESCALATION` | no | Seconds added to the timeout on each retry, capped at 600. Default `120`. |
| `GOOGLE_LOGIN_DOMAIN` | no | Join as a signed-in Google account from this domain. |
| `SIGN_IN_EMAIL` | no | Pin one signed-in account. Put it on the calendar invite to skip the lobby. |
| `STRICT_EMAIL` | no | With `SIGN_IN_EMAIL`, `true` fails if that account is busy instead of falling back. Default `false`. |

---

## The problem

MeetStream bots join Google Meet **anonymously by default**, so Meet's admission rules apply:

- With **Host management** on, only the host and co-hosts (and in some configurations trusted Workspace users) can see and admit a lobby participant. Regular attendees often cannot see the request at all - to them it looks like the bot never showed up, while MeetStream keeps reporting `bot.in_waiting_room`.
- Meet may treat people on the calendar invite as trusted and let them straight in, while an anonymous bot still needs admitting. That is why "everyone else got in, the bot didn't" is such a common report.
- MeetStream can request access and report what happens. It cannot override the organiser's meeting-access settings or Workspace policy.

So a bot that "never joined" is almost always sitting in the lobby.

---

## The three outcomes you have to handle

| Outcome | Webhook | What happened | This template does |
| --- | --- | --- | --- |
| Admitted | `bot.inmeeting` | Someone let it in | Cancel the nudge timer, carry on |
| Lobby timeout | `bot.stopped`, `bot_event: "bot.notallowed"`, `status_code: 500` | Waited the full `waiting_room_timeout`, nobody admitted it | **Retry** with a longer wait, up to `MAX_JOIN_ATTEMPTS` |
| Host denied | `bot.stopped`, `bot_event: "bot.denied"`, `status_code: 500` | A human explicitly rejected the request | **Never retry.** Alert and stop |

That distinction matters. `NotAllowed` is usually a late host and is worth another try. `Denied` is a person saying no - retrying spams them and will be denied again.

There is also `bot.failed`, which this template surfaces with the bot id so you can inspect `GET /bots/{id}/detail`; `bot.kicked`, where a participant removed the bot after admitting it (never retried); and `bot.stopped`, which is a clean exit.

### Reading the webhook

A real delivery looks like this:

```json
{
  "bot_id": "a29d00c3-...",
  "message": "Bot is waiting to be admitted",
  "event": "bot.in_waiting_room",
  "bot_event": "bot.in_waiting_room",
  "bot_status": "InWaitingRoom",
  "status_code": 200,
  "custom_attributes": { "join_attempt": "1" },
  "timestamp": "2026-08-09T07:16:44.675Z"
}
```

`event` is always present and is the generic name; `bot_event` is the specific name and equals `event` on everything except terminals. Every ending arrives exactly once as `event: "bot.stopped"`, and `bot_event` carries the reason:

| `bot_event` | `status_code` | `bot_status` |
| --- | --- | --- |
| `bot.stopped` | 200 | `Stopped` |
| `bot.kicked` | 200 | `Stopped` |
| `bot.notallowed` | 500 | `NotAllowed` |
| `bot.denied` | 500 | `Denied` |
| `bot.failed` | usually 500 | `FAILED` / `ERROR` / `Failed` |

`src/outcomes.js` detects the terminal from `event` and **branches on `bot_event`**. It does not branch on `bot_status`: a kick and a clean exit both say `Stopped`, and the failure casing varies. `bot_status` is only a case-insensitive fallback if `bot_event` is ever missing. `bot.done` still follows every ending (it is the final event on every path); the lobby decision is already known at `bot.stopped`, so this template acts there.

---

## `waiting_room_timeout`

The one lobby knob on `create_bot`:

```json
{
  "meeting_link": "https://meet.google.com/abc-defg-hij",
  "bot_name": "Meeting Assistant",
  "automatic_leave": {
    "waiting_room_timeout": 300
  }
}
```

| | |
| --- | --- |
| Unit | seconds |
| Google Meet range | `60` - `600`. Out of range returns **HTTP 400** |
| Default | `600` (10 minutes) |
| On expiry | the bot leaves; you get `bot.stopped` with `bot_event: "bot.notallowed"` |

Rules of thumb:

- **Ad-hoc "join this call now" bots** - go short (60-120s). Nobody is coming to admit a bot for a call that already started without one.
- **Scheduled bots that arrive early** - go long. The bot may be sitting there before the host has even joined. Cover the gap between join time and the host's realistic arrival.
- **Cost** - a bot waiting in a lobby is a running bot. A 600s timeout on a meeting that never happens is 10 minutes of bot time, every time.

This template starts at `WAITING_ROOM_TIMEOUT` and adds `RETRY_TIMEOUT_ESCALATION` seconds on each retry, capped at the 600s platform maximum.

---

## The nudge

Retrying is a blunt instrument. Most lobby timeouts are one person not looking at the People panel - so before the timeout fires, `LOBBY_ALERT_SECONDS` after the bot enters the lobby, the template raises an alert:

```
[WARN ] Bot has been in the Google Meet lobby for 60s and nobody has admitted it
    bot_id: 4f7c...
    gives_up_in: 240s
    hint: With Host management on, only the host and co-hosts can see the admission request.
```

Alerts go to stdout, and to `NOTIFY_WEBHOOK_URL` as JSON if you set it - point that at whatever you already use for alerting. A failing alert hook is logged, never thrown; it must not take down the webhook receiver.

---

## Signed-in bots: the actual fix

Retries and timeouts manage the symptom. The cure is not being in the lobby at all.

A **signed-in bot** authenticates as a real Google Workspace account before joining. If that account's email is on the calendar invite, Meet treats it as an invited participant and it **skips the waiting room entirely** - no host action, no admission race, nothing to retry.

```env
GOOGLE_LOGIN_DOMAIN=yourdomain.com
SIGN_IN_EMAIL=bot@yourdomain.com
```

which produces:

```json
"google_meet": {
  "login_required": true,
  "google_login_domain": "yourdomain.com",
  "sign_in_email": "bot@yourdomain.com"
}
```

Two conditions, both required:

1. The domain and login are configured (Workspace SSO profile + certificate per mail ID). See the `google-signed-in-bots-setup` template.
2. **`sign_in_email` is on the calendar invite.** Signing in alone gets you a named participant; being invited is what bypasses the lobby.

It also fixes the softer problems: the bot appears with the account's real name and avatar instead of "Unknown", and meetings whose Workspace policy blocks anonymous participants stop rejecting it outright.

Keep the timeout and retry policy anyway as a safety net for the meetings where the invite step was missed.

---

## How it works

```
index.js               config, wiring, graceful shutdown
src/client.js          fetch wrapper - Token auth, 202 pending, 507 replay, backoff on 429/5xx
src/server.js          express receiver; raw-body capture + optional HMAC verification
src/bot.js             create_bot with automatic_leave + optional google_meet block
src/outcomes.js        webhook payload -> { terminal, outcome, retryable, reason }
src/join-manager.js    the retry / nudge / stop policy
src/notify.js          stdout + optional JSON webhook alerts
```

The receiver acknowledges every delivery with `200` **before** running the handler - slow handlers cause redeliveries. Each attempt tags the bot with `custom_attributes.join_attempt` (values must be strings), which is echoed back in every webhook, so events from a superseded attempt are ignored rather than confusing the state machine.

### A note on signatures

Deliveries to a per-bot `callback_url` - what this template uses - are **not signed**. Signature verification (`X-MeetStream-Signature: sha256=<hex>`, HMAC-SHA256 over the raw body, plus `X-MeetStream-Timestamp` for replay windows) applies to **workspace webhook endpoints** created in the dashboard. `src/server.js` implements it correctly, including capturing the raw body before JSON parsing, and turns it on when you set `WEBHOOK_SECRET` - leave that unset for per-bot callbacks.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Configuration error: MEETING_LINK is required` / `PUBLIC_WEBHOOK_URL is required` | `.env` not filled in | `cp .env.example .env` and set both, plus `MEETSTREAM_API_KEY`. |
| HTTP 401 | No API key sent | Set `MEETSTREAM_API_KEY`. |
| HTTP 403 | Key rejected | Copy the whole key from the dashboard. |
| HTTP 400 on `create_bot` | Out-of-range `automatic_leave` value | On Google Meet `waiting_room_timeout` must be 60-600. |
| HTTP 429 or 5xx | Rate limit or transient error | The client backs off and retries; slow down parallel runs. |
| HTTP 507 | Idempotent replay | Treated as success; the original bot is returned. |
| Nothing arrives at the webhook | `PUBLIC_WEBHOOK_URL` not reachable from the internet | Check the tunnel is up and the printed `callback_url` is right. `GET /healthz` confirms the server is listening. |
| `bot.in_waiting_room` forever, no admission prompt visible | The person looking is not the host or a co-host | Ask the organiser to check the People panel and that **Host controls > Meeting access** lets link participants ask to join. Isolate by opening [meet.new](https://meet.new) (you are the host) and sending a bot there. |
| `bot.stopped` with `bot_event: bot.notallowed` (500) | Lobby timeout, nobody admitted the bot | The template retries with a longer timeout up to `MAX_JOIN_ATTEMPTS`; use a signed-in bot on the invite to skip the lobby. |
| Repeated `bot.denied` (500) | Someone is actively rejecting the bot | Talk to the organiser, or switch to an invited signed-in bot. Never retried. |
| `bot.stopped` with `bot_event: bot.kicked` (200) | A participant removed the bot mid-meeting; `bot_status` is `Stopped` just like a clean exit | Only `bot_event` tells it apart. Reported as a kick, not retried. |
| Bot joins but is named "Unknown" | Meet's name resolver takes about 10 seconds | Participant IDs are stable from the first moment; wait. |

---

## Related

- [Google Meet lobby and admission troubleshooting](https://docs.meetstream.ai/guides/app-integrations/gmeet-lobby-admission)
- [Google Meet bots](https://docs.meetstream.ai/guides/platforms/google-meet)
- [Automatic leave configuration](https://docs.meetstream.ai/guides/features/automatic-leave-configuration)
- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Webhook signature verification](https://docs.meetstream.ai/guides/webhooks/webhook-signature-verification)
- [Google signed-in bots](https://docs.meetstream.ai/guides/app-integrations/google-signed-in-bots)
- [Error codes](https://docs.meetstream.ai/errors)
- Labs: [google-signed-in-bots-setup](../google-signed-in-bots-setup), [webhook-handler-complete](../webhook-handler-complete), [bot-status-monitor](../bot-status-monitor)
