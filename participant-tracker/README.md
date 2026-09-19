# Track Meeting Attendance with MeetStream Participant Webhooks

Track who joined and left a Zoom, Google Meet or Microsoft Teams meeting, live over MeetStream's `participant_events.join` / `.leave` webhooks or reconstructed afterwards from `GET /bots/{id}/detail`, and build a per-person attendance report with attended time, share of the meeting, rejoins, first join and last leave.

```bash
cp .env.example .env   # add MEETSTREAM_API_KEY, then either BOT_ID or MEETING_LINK + PUBLIC_URL
npm install
node index.js
```

## What it does

Combines two sources into one attendance record:

| Source | Gives you |
| --- | --- |
| `participant_events.join` / `.leave` webhooks | Exact join and leave timestamps, in real time |
| `GET /bots/{bot_id}/get_participants` | The roster snapshot, used to catch anyone whose events were missed |

The report shows, per person: total attended time, share of the meeting, how
many separate sessions they had (people who dropped and rejoined), first join,
last leave, and whether the figure is exact or estimated.

## Two modes

| You set | Mode |
| --- | --- |
| `MEETING_LINK` + `PUBLIC_URL` | **Live.** Starts a webhook server, sends a bot in, prints joins and leaves as they happen, reports when the meeting ends. |
| `BOT_ID` | **Report.** Replays `bot_details.participant_events` from `GET /bots/{id}/detail` and reconciles against the roster. No server. |

`BOT_ID` wins if both are set.

## Prerequisites

- Node.js 18 or newer (uses the built-in `fetch`)
- A MeetStream API key - <https://app.meetstream.ai>
- **Live mode only:** a public HTTPS URL forwarding to your local port:
  ```bash
  ngrok http 3000
  # or
  cloudflared tunnel --url http://localhost:3000
  ```
  Put the https address in `PUBLIC_URL`.

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/participant-tracker
npm install
cp .env.example .env   # MEETSTREAM_API_KEY plus BOT_ID, or MEETING_LINK + PUBLIC_URL
node index.js
```

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>`. |
| `BOT_ID` | report mode | Rebuild attendance for a bot that already ran. Wins over `MEETING_LINK`. |
| `MEETING_LINK` | live mode | Zoom, Google Meet or Teams link to send a bot into. |
| `PUBLIC_URL` | live mode | Public `https://` base that forwards to `PORT`. `/webhook` and `/participants` are registered under it. |
| `PORT` | no | Local webhook port. Default `3000`. |
| `WEBHOOK_DRAIN_MS` | no | How long to keep listening after the meeting ends so trailing events land. Default `5000`. |
| `BOT_NAME` | no | Display name in the meeting. Default `MeetStream Attendance Bot`. |
| `TRANSCRIPT_LANGUAGE` | no | Language for the Deepgram post-call provider. Default `en`. |
| `RETENTION_HOURS` | no | `recording_config.retention.hours`. Default `72`; the API default when omitted is 720. |
| `WAITING_ROOM_TIMEOUT` | no | `automatic_leave.waiting_room_timeout`, seconds. Default `600`. |
| `EVERYONE_LEFT_TIMEOUT` | no | `automatic_leave.everyone_left_timeout`, seconds. Default `600`. |
| `IN_CALL_RECORDING_TIMEOUT` | no | `automatic_leave.in_call_recording_timeout`, seconds. Default `14400`; API minimum 600. |
| `IDEMPOTENCY_KEY` | no | `Idempotency-Key` for `create_bot`. Unset: a fresh UUID per run. A replay returns HTTP 507, treated as success. |
| `STATUS_POLL_INTERVAL_MS` | no | Delay between `GET /bots/{id}/status` polls. Default `15000`. |
| `STATUS_POLL_MAX_ATTEMPTS` | no | Status poll cap. Default `240`. |
| `OUTPUT_DIR` | no | Where `attendance-<bot_id>.json` is written. Default `./output`. |
| `REQUEST_TIMEOUT_MS` | no | Per-request timeout. Default `30000`. |
| `MAX_RETRIES` | no | Retries on network errors and 429/5xx. 4xx is never retried. Default `3`. |
| `RETRY_BASE_DELAY_MS` | no | Backoff base. Default `1000`. |
| `MEETSTREAM_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |

## How the webhooks are wired

MeetStream delivers these on two separate channels, so the server exposes two
routes:

```
POST <PUBLIC_URL>/webhook       <- create_bot `callback_url`
POST <PUBLIC_URL>/participants  <- recording_config.realtime_endpoints[].url
```

`participant_events` are **opt-in**. The template subscribes on `create_bot`:

```json
{
  "recording_config": {
    "realtime_endpoints": [
      {
        "type": "webhook",
        "url": "https://you.example/participants",
        "events": ["participant_events.join", "participant_events.leave"]
      }
    ]
  }
}
```

Without that block, no join/leave events are delivered or stored, and report
mode has nothing to replay.

### The two envelope shapes

Bot lifecycle events use the standard envelope: `event` is always present,
most deliveries also carry `bot_event` with the specific name, every one
carries an ISO 8601 `timestamp`, and `bot_id` is top level:

```json
{ "event": "bot.inmeeting", "bot_event": "bot.inmeeting", "bot_id": "...",
  "bot_status": "InMeeting", "message": "...", "status_code": 200,
  "timestamp": "2026-05-26T10:04:11.120Z", "custom_attributes": {} }
```

Participant events do not. They nest everything under `data`, and there is
**no top-level `bot_id`**, `bot_status` or `bot_event` - the bot id lives at `data.bot.id`:

```json
{
  "event": "participant_events.leave",
  "timestamp": "2026-05-26T10:11:14.990Z",
  "data": {
    "data": {
      "action": "leave",
      "participant": { "id": "spaces/.../devices/290", "name": "Unknown",
                       "full_name": "Alice", "platform": "gmeet" },
      "timestamp": { "relative": 50.792, "absolute": "2026-05-26T10:11:14.990Z" }
    },
    "bot": { "id": "...", "metadata": {} }
  },
  "custom_attributes": {}
}
```

Parsing participant events with the lifecycle shape is the most common way to
end up with an empty attendance report.

## Finishing reliably

The run ends on whichever comes first:

1. the `bot.stopped` webhook. Every ending arrives as `event: "bot.stopped"`;
   the reason is in `bot_event`: `bot.stopped` (clean exit, `status_code` 200),
   `bot.kicked` (200), `bot.notallowed` (500), `bot.denied` (500), `bot.failed`
   (usually 500). The template branches on `bot_event` and falls back to a
   case-insensitive `bot_status` only when it is missing, because a kick and a
   clean exit both report `Stopped`. Post-call events (`audio.processed`,
   `transcription.processed`, `bot.done`) keep arriving afterwards; attendance
   does not need them,
2. `GET /bots/{id}/status` reaching a terminal status, or
3. Ctrl+C, which sends `GET /bots/{id}/remove_bot` (yes, GET) and reports what
   it has.

Racing the webhook against a status poll means a single dropped webhook cannot
hang the process. After finishing, the template waits `WEBHOOK_DRAIN_MS` for
trailing events, then pulls the roster to reconcile.

## How it works

```
index.js               mode selection, bot creation, finish conditions
src/client.js          MeetStream HTTP client (Token auth, 202/507 handling, retries)
src/session.js         create_bot payload construction
src/webhook.js         express server, two routes, both answer 200 immediately
src/tracker.js         attendance state machine (join/leave pairing, roster merge)
src/report.js          terminal report
src/format.js          duration / percent / table helpers
```

`src/tracker.js` is pure state, no I/O - lift it straight into your own service.

## Output

Console:

```
  [lifecycle] bot.inmeeting (InMeeting)
  [participants] Alice joined
  [participants] Bob joined
  [participants] Bob left
  [lifecycle] bot.stopped (Stopped)

Who attended
============

Participant  Attended  Of meeting  Sessions  First join            Last leave            Note
-----------  --------  ----------  --------  --------------------  --------------------  ----
Alice         31m 04s       98.2%         1  2026-05-26 10:04:11Z  2026-05-26 10:35:15Z
Bob           12m 41s       40.1%         2  2026-05-26 10:06:02Z  2026-05-26 10:33:44Z
```

File: `output/attendance-<bot_id>.json` - full report including every session
and the raw event log.

## Accuracy caveats

- Someone already in the call when the bot joins produces **no join event**.
  Their attended time is bounded by the meeting start instead and marked
  *estimated*.
- Someone still present when the bot leaves produces no leave event; they are
  marked *never left* and bounded by the meeting end.
- Platforms report a participant identity per device. Joining from two devices
  shows as two participants.
- Report mode depends on `bot_details.participant_events` being populated,
  which only happens if the bot subscribed to those events at creation.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `MEETSTREAM_API_KEY is not set` | No `.env`, or an empty key. | `cp .env.example .env` and paste your key. |
| HTTP 401 / 403 | No key sent, or the key is inactive for this workspace. | The header is `Authorization: Token <key>`; regenerate the key if 403 persists. |
| `PUBLIC_URL is required in live mode` | No tunnel URL. | Start a tunnel and set `PUBLIC_URL` to its https address. |
| No `[participants]` lines at all | The tunnel is not reaching you, or `realtime_endpoints` was not accepted on create. | `curl $PUBLIC_URL/health`; check the create response. |
| Lifecycle events arrive, participant events do not | `callback_url` is fine but `realtime_endpoints` is not. | Check the URL and the `events` array. |
| "No participants were recorded" | Bot never joined, or events never arrived. | Check `GET /bots/{id}/status`. |
| Report mode finds zero events | The bot was created without `realtime_endpoints`, so nothing was stored. | Only the roster is available; re-run live with the subscription. |
| HTTP 400 on create | An unreachable `realtime_endpoints` URL, or `in_call_recording_timeout` below its 600 second minimum. | Fix the URL or the timeout. |
| HTTP 404 in report mode | Wrong `BOT_ID`, or the recording expired via its retention window. | Confirm the id in the dashboard. |
| Meeting finished with `bot.notallowed` / `bot.denied` | Never admitted from the waiting room / host refused. Nothing was recorded. | Admit the bot, or ask the host to allow it. |
| Everyone shows as "Unknown" | The platform did not expose display names. | `full_name` falls back to `name`, then to `Unknown`; nothing to fix client-side. |

## Related

- [Participants and speaker timeline](https://docs.meetstream.ai/guides/features/participants-and-speaker-timeline)
- [Fetch participants](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/fetch-participants)
- [Get bot details](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-details)
- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Local webhook server](https://docs.meetstream.ai/guides/webhooks/local-webhook-server)
- [Automatic leave configuration](https://docs.meetstream.ai/guides/features/automatic-leave-configuration)
- Sibling templates: [speaker-timeline-analytics](../speaker-timeline-analytics), [webhook-handler-complete](../webhook-handler-complete), [meeting-chat-logger](../meeting-chat-logger), [webhook-local-tunnel](../webhook-local-tunnel)
