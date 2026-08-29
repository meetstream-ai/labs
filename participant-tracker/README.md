# Participant Tracker

Track who joined and left a meeting - live over webhooks or reconstructed
afterwards - and build an attendance report.

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

Bot lifecycle events use the standard envelope - key is **`event`**, and
`bot_id` is top level:

```json
{ "event": "bot.inmeeting", "bot_id": "...", "bot_status": "InMeeting",
  "message": "...", "status_code": 200, "custom_attributes": {} }
```

Participant events do not. They nest everything under `data`, and there is
**no top-level `bot_id`** - it lives at `data.bot.id`:

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

1. the `bot.stopped` webhook (`status_code` is **200 regardless of reason** -
   the reason is in `bot_status`: `Stopped`, `NotAllowed`, `Denied`, `Error`),
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

| Symptom | Cause and fix |
| --- | --- |
| `PUBLIC_URL is required in live mode` | Start a tunnel and set `PUBLIC_URL` to its https address. |
| No `[participants]` lines at all | The tunnel is not reaching you (`curl $PUBLIC_URL/health`), or `realtime_endpoints` was not accepted on create. |
| Lifecycle events arrive, participant events do not | `callback_url` is fine but `realtime_endpoints` is not - check the URL and the `events` array. |
| "No participants were recorded" | Bot never joined, or events never arrived. Check `GET /bots/{id}/status`. |
| Report mode finds zero events | The bot was created without `realtime_endpoints`, so nothing was stored. Only the roster is available. |
| HTTP 400 on create | An unreachable `realtime_endpoints` URL, or `in_call_recording_timeout` below its 600 second minimum. |
| HTTP 401 / 403 | No key sent, or the key is inactive for this workspace. |
| Everyone shows as "Unknown" | The platform did not expose display names. `full_name` falls back to `name`, then to `Unknown`. |

## Resources

- [MeetStream docs](https://docs.meetstream.ai)
- [API reference](https://docs.meetstream.ai/api-reference)
