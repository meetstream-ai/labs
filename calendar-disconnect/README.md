# Disconnect a Google or Outlook Calendar from the MeetStream API

Tear down a Google Calendar or Outlook calendar integration with the MeetStream API's `POST /calendar/disconnect`, which stops calendar sync and cancels every meeting bot still scheduled to join Zoom, Google Meet or Microsoft Teams calls. This is destructive and irreversible, so the template previews exactly what will be deleted and requires a typed confirmation.

```bash
npm install
cp .env.example .env      # fill in MEETSTREAM_API_KEY
node index.js preview     # safe, read only
node index.js disconnect  # asks you to type "disconnect"
```

## What gets deleted

Disconnecting removes four things, and none of them come back:

1. **Push notification channels** (Google watch channels, Microsoft Graph subscriptions). Real-time calendar sync stops.
2. **Every pending bot schedule.** Bots in `Scheduled` status move to `Cancelled`. They will not join their meetings.
3. **All synced event data.** The event rows MeetStream stored for this connection are deleted.
4. **The stored OAuth credentials.** To reconnect you need your client id, client secret and refresh token again.

What survives: bots that have **already run**. Their recordings, transcripts and metadata are untouched. Disconnecting a calendar is not a data deletion request for past meetings.

## Prerequisites

- Node.js 18 or newer.
- A MeetStream API key from <https://app.meetstream.ai>.
- A connected calendar. If nothing is connected, `preview` tells you so.

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/calendar-disconnect
npm install
cp .env.example .env      # fill in MEETSTREAM_API_KEY
node index.js preview
```

## Environment variables

| Name | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | API key from <https://app.meetstream.ai>, sent as `Authorization: Token <key>`. |
| `MEETSTREAM_API_BASE_URL` | no | API base URL. Default `https://api.meetstream.ai/api/v1`. |
| `GOOGLE_CLIENT_ID` | no | Google OAuth client id. Only sent when all three Google values are set. |
| `GOOGLE_CLIENT_SECRET` | no | Google OAuth client secret. Never printed. |
| `GOOGLE_REFRESH_TOKEN` | no | Google OAuth refresh token. Never printed. |

## Usage

```bash
node index.js preview                                              # read only
node index.js disconnect                                           # prompts
node index.js disconnect --yes                                     # skip the prompt
node index.js disconnect --provider outlook                        # every Outlook connection
node index.js disconnect --provider outlook --account-id jane@acme.com
node index.js disconnect --keep-events                             # purge_events: false
```

`preview` output:

```
Checking what is currently connected...

Connections: 1
  - [google]  jane@example.com

Calendars  : 2
  - jane@example.com  (primary)
  - Team Meetings

Scheduled bots: 3
  - 2026-04-08T14:59:00+00:00  bot_111aaa12  MeetStream Calendar Bot
  - 2026-04-09T09:59:00+00:00  bot_222bbb34  MeetStream Auto Bot
  - 2026-04-10T15:59:00+00:00  bot_333ccc56  MeetStream Auto Bot

Synced events : 42

Nothing was changed. To actually disconnect:  node index.js disconnect
```

Then the confirmation gate:

```
================================================================
DISCONNECTING REMOVES, IRREVERSIBLY:
  1. Push notification channels / Graph subscriptions (no more real-time sync)
  2. Every pending bot schedule (3 right now)
  3. All synced event data
  4. The stored OAuth credentials

Bots that have already run keep their recordings and transcripts.
To reconnect afterwards you need your OAuth credentials again.
================================================================

This cannot be undone.
Type "disconnect" to continue:
```

## How it works

### `POST /calendar/disconnect`

Body shapes, all documented and all optional:

| Body | Effect |
|---|---|
| `{}` | Tears down the one connection. **400** if the user has several. |
| `{ "provider": "outlook" }` | Removes every Outlook connection, leaves Google alone. |
| `{ "provider": "outlook", "account_id": "jane@acme.com" }` | Removes exactly that connection. |
| `{ ..., "purge_events": false }` | Removes credentials and subscriptions but keeps the historical event rows. |

The API reference also documents `google_client_id`, `google_client_secret` and `google_refresh_token` on this body. If all three are set in `.env` the template includes them, otherwise it sends the scoped form. Values are redacted in the console output, never printed.

Response:

```json
{
  "disconnected": true,
  "user_id": "usr_abc123",
  "watch_channel_stopped": true,
  "events_deleted": 42,
  "schedules_cancelled": 5,
  "message": "Calendar disconnected successfully. All events and scheduled bots have been removed."
}
```

### The 400 safety net

With several connections attached and no explicit scope, the API deliberately **refuses** rather than wiping everything by implication:

```json
{
  "error": "Multiple calendar connections present; refusing to disconnect all without explicit account_id",
  "scope": "all",
  "connection_count": 3,
  "next_steps": "POST this endpoint again with an explicit scope, for example body {\"provider\": \"...\", \"account_id\": \"...\"}."
}
```

The template surfaces that response verbatim, including `next_steps`, and exits non-zero instead of raising a generic error.

### Disconnecting one account

There is only one disconnect endpoint: `POST /calendar/disconnect`. There is no
`/calendar/connections/{provider}/{account_id}` path in the API.

To target a single connection, scope the request body instead:

```json
{ "provider": "outlook", "account_id": "jane@acme.com" }
```

Pass them with `--provider` and `--account-id`. Add `--keep-events` to keep that
account's historical event rows.

### POST versus DELETE

The API reference and the OpenAPI spec both publish this as **POST**. Some documentation pages show the same operation as **DELETE**. The template calls POST first, and if that returns 404 or 405 it retries the identical body as DELETE and says which verb answered. You do not have to work out which one your deployment wants.

### Confirmation

The prompt requires you to type `disconnect` exactly. `--yes` skips it for scripts. When stdin is not a TTY the prompt refuses to confirm implicitly and tells you to pass `--yes`, so a piped or CI run cannot destroy a connection by accident.

## Alternatives to disconnecting

Disconnecting is a large hammer. Depending on what you actually want:

| Goal | Better option |
|---|---|
| Stop new bots being scheduled automatically | `POST /calendar/auto-schedule/disable`, see `calendar-auto-schedule` |
| Cancel the bots that are already booked | `manage-scheduled-bots cancel-all` |
| Remove a bot from one meeting | `DELETE /calendar/schedule/{event_id}`, see `calendar-schedule-bot` |
| Stop a recurring series re-booking | `POST /calendar/toggle-recurrence` with `recurring_enabled: false` |
| Rotate OAuth credentials | Just call `create_calendar` / `create_outlook_calendar` again. No disconnect needed. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `MEETSTREAM_API_KEY is not set` | `.env` missing or blank | `cp .env.example .env` and fill in the key. |
| API error 401 | No API key was sent | Set `MEETSTREAM_API_KEY`. |
| API error 403 | Key rejected or belongs to another workspace | Copy the whole key from the dashboard. |
| API error 400 with `next_steps` | Several connections and no scope | Re-run with `--provider` and `--account-id`. |
| API error 404 | Nothing is connected | Run `preview` first; there is nothing to disconnect. |
| API error 429 | Rate limited | Back off and retry. |
| `preview` shows no calendars | No connection exists, or the key belongs to a different account | Check the key and workspace. |
| Prompt refuses to accept input | stdin is not a TTY | Use `--yes`. |
| Bots still joined after disconnecting | They had already started | Only `Scheduled` bots are cancelled; use `remove_bot` on live ones. |
| Need the event history back | Not recoverable | Use `--keep-events` next time. |

## Related

- [Disconnect calendar](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/disconnect-calendar)
- [Get calendars](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/get-calendars)
- [List scheduled bots](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/list-scheduled-bots)
- [Google Calendar OAuth setup](https://docs.meetstream.ai/guides/calendar-integrations/google-calendar-oauth-setup)
- [Outlook calendar setup](https://docs.meetstream.ai/guides/calendar-integrations/outlook-calendar-setup)
- [Error codes](https://docs.meetstream.ai/errors)
- Labs: [google-calendar-integration](../google-calendar-integration) and [outlook-calendar-integration](../outlook-calendar-integration) reconnect afterwards; [manage-scheduled-bots](../manage-scheduled-bots) cancels bots without dismantling the connection; [calendar-auto-schedule](../calendar-auto-schedule) turns auto-join off without dismantling it.
