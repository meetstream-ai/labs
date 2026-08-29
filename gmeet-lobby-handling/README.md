# Google Meet Lobby Handling

Send a bot into a Google Meet, watch what the waiting room does to it, and react: nudge a human while it waits, retry when it times out, and stop cleanly when a host says no.

```bash
npm install
cp .env.example .env      # MEETSTREAM_API_KEY, MEETING_LINK, PUBLIC_WEBHOOK_URL
node index.js
```

You need a publicly reachable webhook URL. In another terminal: `ngrok http 3000`, then put the https origin in `PUBLIC_WEBHOOK_URL`.

Want to watch events without creating a bot? `node index.js listen`.

---

## The problem

MeetStream bots join Google Meet **anonymously by default**, so Meet's admission rules apply:

- With **Host management** on, only the host and co-hosts (and in some configurations trusted Workspace users) can see and admit a lobby participant. Regular attendees often cannot see the request at all - to them it looks like the bot never showed up, while MeetStream keeps reporting `bot.in_waiting_room`.
- Meet may treat people on the calendar invite as trusted and let them straight in, while an anonymous bot still needs admitting. That is why "everyone else got in, the bot didn't" is such a common report.
- MeetStream can request access and report what happens. It cannot override the organiser's meeting-access settings or Workspace policy.

So a bot that "never joined" is almost always sitting in the lobby.

---

## The three outcomes you have to handle

| Outcome | `bot_status` | What happened | This template does |
| --- | --- | --- | --- |
| Admitted | `InMeeting` | Someone let it in | Cancel the nudge timer, carry on |
| Lobby timeout | `NotAllowed` | Waited the full `waiting_room_timeout`, nobody admitted it | **Retry** with a longer wait, up to `MAX_JOIN_ATTEMPTS` |
| Host denied | `Denied` | A human explicitly rejected the request | **Never retry.** Alert and stop |

That distinction matters. `NotAllowed` is usually a late host and is worth another try. `Denied` is a person saying no - retrying spams them and will be denied again.

There is also `Error` (`bot.failed`), which this template surfaces with the bot id so you can inspect `GET /bots/{id}/detail`, and `Stopped`, which is a clean exit.

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

`src/outcomes.js` reads the event name from `event`, falling back to the `bot_event` alias, and then **branches on `bot_status`**. That is deliberate: a terminal result may arrive either as `bot.stopped` carrying a `bot_status` that explains why, or as the more specific `bot.notallowed` / `bot.denied` / `bot.kicked` / `bot.failed` event. `bot_status` is the same value in both shapes, so it is the stable thing to switch on. Do not branch on `status_code` alone.

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
| On expiry | the bot leaves; you get a terminal event with `bot_status: "NotAllowed"` |

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

**Nothing arrives at the webhook** - `PUBLIC_WEBHOOK_URL` has to be reachable from the internet. Check the tunnel is up and that the printed `callback_url` is the one you expect. `GET /healthz` on the server confirms it is listening.

**HTTP 400 on create_bot** - almost always an out-of-range `automatic_leave` value. On Google Meet `waiting_room_timeout` must be 60-600.

**`bot.in_waiting_room` forever, no admission prompt visible** - the person looking is probably not the host or a co-host. Ask the organiser to check the People panel, and check **Host controls → Meeting access** allows link participants to ask to join. Isolate it by opening [meet.new](https://meet.new) (you are the host there) and sending a bot at it.

**Repeated `Denied`** - someone is actively rejecting the bot. Talk to the organiser, or switch to an invited signed-in bot.

**Bot joins but is named "Unknown"** - Meet's name resolver takes about 10 seconds to populate. Participant IDs are stable from the first moment.

**`bot.kicked`** - a host removed the bot mid-meeting. `bot_status` is `Stopped`; this template treats it as a clean exit, not a retry candidate.

---

## Docs

- [Google Meet Lobby & Admission Troubleshooting](https://docs.meetstream.ai/guides/app-integrations/gmeet-lobby-admission)
- [Google Meet Bots](https://docs.meetstream.ai/guides/platforms/google-meet)
- [Automatic Leave Configurations](https://docs.meetstream.ai/guides/features/automatic-leave-configuration)
- [Webhooks and Events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Verifying Webhook Signatures](https://docs.meetstream.ai/guides/webhooks/webhook-signature-verification)
- [Google Signed-In Bots](https://docs.meetstream.ai/guides/app-integrations/google-signed-in-bots)
