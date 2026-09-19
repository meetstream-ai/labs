# Schedule a Meeting Bot for a Future Time with the MeetStream API

Schedule a MeetStream meeting bot for a future Zoom, Google Meet or Microsoft Teams meeting with `join_at`, list what is scheduled with `GET /calendar/scheduled_bots`, move it with `PATCH /calendar/scheduled_bots/{bot_id}`, and cancel it with `DELETE /calendar/scheduled_bots/{bot_id}`.

## How it works

- `create` calls `POST /bots/create_bot` with a future `join_at` (from `--in <minutes>` or `--at <iso>`); the bot sits idle until then and runs the normal lifecycle.
- `list` reads `GET /calendar/scheduled_bots`, the dedicated upcoming-bots endpoint; `list --all` pages `GET /bots` instead and keeps every record with a `join_at`, including ones that already ran.
- `reschedule` sends `PATCH /calendar/scheduled_bots/{bot_id}` with `scheduled_join_time`; `cancel` sends `DELETE /calendar/scheduled_bots/{bot_id}`. Both only work before the bot joins.

## Prerequisites

- Node.js 18 or newer (built-in `fetch`)
- A MeetStream API key from <https://app.meetstream.ai>
- A Zoom, Google Meet or Teams link for a meeting that has not started yet

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/scheduled-bot-join-at
npm install
cp .env.example .env   # then fill in MEETSTREAM_API_KEY and MEETING_LINK
node index.js create --in 30
node index.js list
```

## Usage

```bash
node index.js create --in 30                      # join in 30 minutes
node index.js create --at 2026-07-02T15:00:00Z    # join at an exact time
node index.js list                                # upcoming scheduled bots
node index.js list --all                          # include past join_at times
node index.js reschedule bot_abc123 --in 90       # move it
node index.js reschedule bot_abc123 --at 2026-07-02T16:30:00Z
node index.js cancel bot_abc123                   # cancel before it joins
node index.js --help
```

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>`. |
| `MEETING_LINK` | for `create` | Full Zoom, Google Meet or Teams link. |
| `BOT_ID` | no | Default target for `reschedule` and `cancel`; the positional argument overrides it. |
| `BOT_NAME` | no | Display name in the meeting. Default `Scheduled Bot`. |
| `VIDEO_REQUIRED` | no | `true` records video too. Default `false`. |
| `MEETSTREAM_API_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |

## How scheduling works

A scheduled bot is an ordinary bot created with a future `join_at`:

```http
POST /bots/create_bot

{
  "meeting_link": "https://meet.google.com/xxx-xxxx-xxx",
  "bot_name": "Scheduled Bot",
  "video_required": false,
  "join_at": "2026-07-02T15:00:00Z"
}
```

`join_at` is ISO 8601. The template accepts `--in <minutes>` and converts it for you, or `--at <iso>` if you already have a timestamp. Both are normalised to UTC before they are sent.

The response is the usual `{ bot_id, transcript_id, meeting_url, status }`. The bot then sits idle until `join_at`, at which point it runs the normal lifecycle: `Joining`, `InWaitingRoom`, `InMeeting`, `Recording`, `Leaving`, `Stopped`. With a `callback_url` you also get a `bot.scheduled` webhook up front.

## Listing scheduled bots

`GET /calendar/scheduled_bots` returns every bot with a scheduled join time in the future, whether it came from `join_at` or from a connected calendar:

```json
{
  "scheduled_bots": [
    {
      "bot_id": "bot_111...",
      "platform": "GMeet",
      "status": "Scheduled",
      "scheduled_join_time": "2026-04-08T14:59:00+00:00",
      "bot_username": "MeetStream Calendar Bot",
      "meeting_link": "https://meet.google.com/abc-defg-hij"
    }
  ]
}
```

That endpoint only shows upcoming bots. `list --all` pages `GET /bots` (`{ bots, hasNextPage, nextCursor }`) and keeps the records that carry a `join_at`, which is how you check whether yesterday's scheduled bot actually ran.

## Rescheduling and cancelling

Both live under `/calendar`, and both work on any scheduled bot, whether or not it came from a connected calendar. Note the reschedule body field is `scheduled_join_time`, not `join_at`.

```http
PATCH /calendar/scheduled_bots/{bot_id}
{ "scheduled_join_time": "2026-07-02T16:30:00Z" }
```

```http
DELETE /calendar/scheduled_bots/{bot_id}
```

Both only apply **before** the bot joins. Once the session is live the schedule no longer exists to change:

| Situation | Call |
|---|---|
| Bot has not joined yet | `PATCH` to move it, `DELETE` to cancel |
| Bot is in the meeting now | `GET /bots/{id}/remove_bot` to make it leave |
| Session is over and you want the data gone | `DELETE /bots/{id}/delete` |

Those are three different endpoints doing three different things. Only the last one destroys data.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `MEETSTREAM_API_KEY is not set` | No `.env` or empty key. | `cp .env.example .env` and paste your key. |
| `API error 401` / `403` | No key sent, or the key was rejected. | Check the key is complete and active for this workspace. |
| `--at is not a valid date` | The timestamp is not ISO 8601 with an explicit zone. | Use `2026-07-02T15:00:00Z`. A bare `2026-07-02 15:00` is ambiguous. |
| "That time is in the past" | The bot will try to join immediately. | Check whether you meant local time and forgot the `Z`. |
| `API error 400` on create | Invalid `meeting_link` or a `join_at` the API rejects. | Paste a full meeting link; keep `join_at` in the future. |
| `API error 404` on reschedule or cancel | The bot already joined, was already cancelled, or the id is wrong. | Run `node index.js list --all` to see what exists. |
| `API error 429` | Rate limited. | Wait and retry. |
| The bot never joined | The meeting link expired, or the meeting was moved. `join_at` only controls when the bot dials in. | Confirm the link is still valid at join time. |
| Nothing in `list` but you just scheduled one | The bot's join time is already in the past, or the record uses a key this filter does not expect. | Run `list --all`, and use the list-and-manage-bots template with `--json` to see the raw records. |

## Related

- [Scheduling bots guide](https://docs.meetstream.ai/guides/features/scheduling-bots)
- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [List scheduled bots](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/list-scheduled-bots)
- [Reschedule bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/reschedule-bot)
- [Delete scheduled bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/delete-scheduled-bot)
- [Remove bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/remove-bot)
- [Error reference](https://docs.meetstream.ai/errors)
- Templates: [manage-scheduled-bots](../manage-scheduled-bots/README.md), [calendar-schedule-bot](../calendar-schedule-bot/README.md), [list-and-manage-bots](../list-and-manage-bots/README.md)
