# Zoom Meeting Bot

Send a MeetStream bot into a Zoom meeting and handle the one thing Zoom does that Google Meet and Microsoft Teams do not: **recording is gated on host consent**.

```bash
npm install
cp .env.example .env      # MEETSTREAM_API_KEY, MEETING_LINK, PUBLIC_WEBHOOK_URL
node index.js
```

`node index.js check` validates your config and prints the exact `create_bot` body without calling the API. `node index.js listen` runs the webhook receiver on its own.

You need a publicly reachable webhook URL: `ngrok http 3000`, then put the https origin in `PUBLIC_WEBHOOK_URL`.

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

The receiver acknowledges each delivery with `200` before running the handler; slow handlers cause redeliveries.

### Signatures

Deliveries to a per-bot `callback_url` are **not signed**. Signature verification (`X-MeetStream-Signature: sha256=<hex>`, HMAC-SHA256 over the raw body) applies to **workspace webhook endpoints** created in the dashboard. `src/server.js` implements it and turns it on when `WEBHOOK_SECRET` is set - leave it unset for per-bot callbacks.

---

## Troubleshooting

**Bot joins but never records** - the host never granted permission. Watch for `bot.recording_permission_allowed` / `bot.recording_permission_denied`, and raise `RECORDING_PERMISSION_DENIED_TIMEOUT` (max 300).

**Bot can only join my own meetings** - your Marketplace app is still in development mode. Submit it for production approval.

**Bot never gets in at all** - check in order: the link is valid and unexpired; the `?pwd=` component is present for password-protected meetings; the app is out of development mode for other people's meetings; the bot did not simply sit in the waiting room until `waiting_room_timeout` fired (`bot.stopped` with `bot_event: "bot.notallowed"`).

**OBF joins suddenly fail for one user** - their connection was revoked. A Zoom password change, uninstalling the app, or 90+ days idle all do it. They need to reconnect.

**HTTP 400 from create_bot** - an out-of-range `automatic_leave` value. `recording_permission_denied_timeout` 60-300, `waiting_room_timeout` 60-1200, `in_call_recording_timeout` at least 600.

**HTTP 403** - the API key is not valid for this workspace. If the key is right, check the Zoom credentials are actually connected under Dashboard → Integrations → Zoom.

---

## Docs

- [Zoom Meeting Bots](https://docs.meetstream.ai/guides/platforms/zoom)
- [Zoom Marketplace App Setup](https://docs.meetstream.ai/guides/app-integrations/zoom-marketplace-app-setup)
- [Zoom App Production Submission](https://docs.meetstream.ai/guides/app-integrations/zoom-app-production-submission)
- [Zoom OBF Implementation](https://docs.meetstream.ai/guides/app-integrations/zoom-authenticated-bots)
- [Automatic Leave Configurations](https://docs.meetstream.ai/guides/features/automatic-leave-configuration)
- [Webhooks and Events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
