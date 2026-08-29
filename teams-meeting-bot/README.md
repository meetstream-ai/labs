# Microsoft Teams Meeting Bot

Send a MeetStream bot into a Microsoft Teams meeting, follow its lifecycle over webhooks, and understand what Teams does differently from Zoom and Google Meet.

```bash
npm install
cp .env.example .env      # MEETSTREAM_API_KEY, MEETING_LINK, PUBLIC_WEBHOOK_URL
node index.js
```

`node index.js check` validates your config and prints the exact `create_bot` body without calling the API. `node index.js listen` runs the webhook receiver on its own.

You need a publicly reachable webhook URL: `ngrok http 3000`, then put the https origin in `PUBLIC_WEBHOOK_URL`.

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

There is no `teams` block on `create_bot` the way Zoom has `zoom` and Google Meet has `google_meet` - the platform is inferred from the link. Use the join URL exactly as it appears in the invite; do not trim its query string.

Azure app registration is only needed for the **Outlook Calendar** integration (auto-joining scheduled meetings), never for sending a bot at a link you already have.

---

## Lobby and admission

Teams meetings can hold a joining participant in a lobby, and MeetStream reports that as `bot.in_waiting_room` with `bot_status: "InWaitingRoom"`. Whether the bot waits at all, and who is allowed to admit it, is decided by the meeting's own Teams admission policy - MeetStream can request access and report what happens, it cannot override the organiser's settings or the tenant's policy.

What is documented and dependable:

- **`waiting_room_timeout`** controls how long the bot waits. On Teams the range is `60`-`1800` seconds, default `600`. Out of range returns HTTP 400.
- If the timeout elapses without admission, the run ends with **`bot_status: "NotAllowed"`**.
- If someone explicitly rejects the request, you get **`bot_status: "Denied"`**.
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
| Signed-in / authenticated bot identity | Not applicable - the `google_meet` block is Meet-only | OBF hosted OAuth joins as one of your end users | `google_meet.login_required` signed-in bots |
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
  -> bot.stopped              terminal; bot_status says why
  -> manifest.completed / audio.processed / transcription.processed / video.processed
  -> bot.done
  -> data_deletion            when retention expires or you delete the data
```

Payloads carry the event name under `event`, with `bot_event` as an alias:

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

`src/lifecycle.js` reads `event` and falls back to `bot_event`, then **branches on `bot_status`**. A terminal result may arrive either as `bot.stopped` carrying a status that explains why, or as the more specific `bot.notallowed` / `bot.denied` / `bot.kicked` / `bot.failed` event - `bot_status` is the same value in both shapes, so it is the stable thing to switch on.

Streaming-only transcription providers end the pipeline at `audio.processed` and never emit `bot.done`; do not block on it in that case.

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

**Bot sits in the lobby and is never admitted** - the run ends with `NotAllowed`. Someone with admission rights has to let it in, or the meeting's lobby policy has to allow it. Raise `WAITING_ROOM_TIMEOUT` (up to 1800) if the bot simply arrives before anyone else.

**HTTP 400 from create_bot** - an out-of-range `automatic_leave` value (`waiting_room_timeout` 60-1800 on Teams, `in_call_recording_timeout` at least 600), or a malformed link.

**`transcript_id` is null** - expected if you used `meeting_captions`, or if you set no post-call provider at all.

**A participant's video split into several files** - on Teams a webcam dimension change (or a screen-share resolution change) starts a new segment. Segments are chronologically ordered with `segment_index`.

**Nothing arrives at the webhook** - `PUBLIC_WEBHOOK_URL` must be reachable from the internet. Check the tunnel and the printed `callback_url`; `GET /healthz` confirms the server is up.

---

## Docs

- [Microsoft Teams Bots](https://docs.meetstream.ai/guides/platforms/microsoft-teams)
- [Automatic Leave Configurations](https://docs.meetstream.ai/guides/features/automatic-leave-configuration)
- [Webhooks and Events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Outlook Calendar Setup](https://docs.meetstream.ai/guides/calendar-integrations/outlook-calendar-setup)
- [Per-participant audio](https://docs.meetstream.ai/guides/transcription-recordings/per-participant-audio) and [video](https://docs.meetstream.ai/guides/transcription-recordings/per-participant-video)
- [Debugging Bots](https://docs.meetstream.ai/guides/help/debugging-bots)
