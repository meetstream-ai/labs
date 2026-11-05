# List, Reschedule and Cancel Scheduled MeetStream Bots

Admin CLI for MeetStream API meeting bots that have not joined their Zoom, Google Meet or Microsoft Teams call yet: list them with `GET /calendar/scheduled_bots`, change the join time, name or custom attributes with `PATCH /calendar/scheduled_bots/{bot_id}`, and cancel them with `DELETE /calendar/scheduled_bots/{bot_id}`.

```bash
npm install
cp .env.example .env      # fill in MEETSTREAM_API_KEY
node index.js list
```

## Commands

| Command | Call | Effect |
|---|---|---|
| `list [--limit n] [--json]` | `GET /calendar/scheduled_bots` | Table of every upcoming bot |
| `show <botId>` | list plus `GET /bots/{id}/status` | One bot in detail, with live status |
| `reschedule <botId> <iso>` | `PATCH .../{bot_id}` | Move the join time |
| `update <botId> [--time] [--name] [--attr k=v]` | `PATCH .../{bot_id}` | Change time, display name or custom attributes |
| `cancel <botId> [--yes]` | `DELETE .../{bot_id}` | Cancel one bot, with confirmation |
| `cancel-all [--yes]` | `DELETE .../{bot_id}` per bot | Cancel everything upcoming, with confirmation |

## Prerequisites

- Node.js 18 or newer.
- A MeetStream API key from <https://app.meetstream.ai>.
- At least one scheduled bot. Create one with `calendar-schedule-bot`, `calendar-auto-schedule`, or `create_bot` with a future `join_at`.

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/manage-scheduled-bots
npm install
cp .env.example .env      # fill in MEETSTREAM_API_KEY
node index.js list
```

## Environment variables

| Name | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | API key from <https://app.meetstream.ai>, sent as `Authorization: Token <key>`. |
| `LIST_LIMIT` | no | Default page size for `list`, 1 to 100. Default `100`. `--limit` overrides it. |
| `MEETSTREAM_API_BASE_URL` | no | API base URL. Default `https://api.meetstream.ai/api/v1`. |

## Usage

```bash
node index.js list
```

```
JOIN TIME (UTC)             STATUS        PLATFORM    BOT ID                    NAME
--------------------------  ------------  ----------  ------------------------  ------------------------
2026-04-08T14:59:00+00:00   Scheduled     GMeet       bot_111aaa12              MeetStream Calendar Bot
2026-04-09T09:59:00+00:00   Scheduled     Zoom        bot_222bbb34              MeetStream Auto Bot

2 scheduled bot(s).
```

```bash
node index.js show bot_111aaa12
node index.js reschedule bot_111aaa12 2026-04-22T15:00:00Z
node index.js update bot_111aaa12 --time 2026-04-22T15:00:00Z --name "VIP Notetaker" --attr deal_id=12345
node index.js cancel bot_111aaa12
node index.js cancel-all --yes
```

## How it works

### `GET /calendar/scheduled_bots`

Returns **every** bot with a join time in the future, which includes both calendar-scheduled bots and one-off bots created through `create_bot` with a future `join_at`. Not only calendar ones, despite the path.

Query parameter `limit`, 1 to 100, default 100.

```json
{
  "scheduled_bots": [
    {
      "bot_id": "bot_111aaa12",
      "platform": "GMeet",
      "status": "Scheduled",
      "scheduled_join_time": "2026-04-08T14:59:00+00:00",
      "bot_username": "MeetStream Calendar Bot",
      "meeting_link": "https://meet.google.com/abc-defg-hij",
      "custom_attributes": { "source": "calendar_integration" }
    }
  ]
}
```

100 is the page maximum and there is no cursor on this endpoint, so a very large queue may be truncated. The template says so when it gets exactly 100 back.

### `PATCH /calendar/scheduled_bots/{bot_id}`

```json
{
  "scheduled_join_time": "2026-04-22T15:00:00Z",
  "bot_username": "Updated Bot Name",
  "custom_attributes": { "note": "VIP meeting" }
}
```

| Field | Notes |
|---|---|
| `scheduled_join_time` | ISO 8601, must be in the future. Moves the underlying schedule, not just the record. |
| `bot_username` | Display name the bot shows in the meeting |
| `custom_attributes` | Object of string values |

Response: `{ message, bot_id, updated_fields, schedule_updated }`.

One inconsistency to be aware of: the published request schema marks `scheduled_join_time` as **required**, while the integration guide describes all three fields as optional. The `update` command sends whatever you pass and warns before a name-only or attribute-only patch, since that is the case where the two disagree. `reschedule` always sends a time and is therefore always safe.

The template validates the timestamp locally before sending: it must parse as ISO 8601 and be in the future. That turns a server-side 400 into a clearer message.

### `DELETE /calendar/scheduled_bots/{bot_id}`

Cancels a bot that has not joined yet. Response: `{ message, bot_id }`.

This deletes a **scheduled** bot. It is not the same as `DELETE /bots/{id}/delete`, which destroys the recordings and data of a bot that already ran.

### Confirmation

`cancel` and `cancel-all` prompt before deleting. `cancel-all` requires you to type `cancel all`, not just `yes`, because it walks the whole queue.

Both accept `--yes` to skip the prompt in scripts. When stdin is not a TTY the prompt refuses to confirm implicitly and tells you to pass `--yes`, so a piped or CI run can never delete by accident.

`cancel-all` keeps going past individual failures, reports a per-bot result, and exits non-zero if any deletion failed.

### Scheduled bots versus the calendar

If a bot came from a calendar event, editing the meeting in the calendar also moves the bot. MeetStream reacts to the provider's push notifications and updates the join time on its own. `PATCH` is for when you want the bot to differ from the calendar, for example joining 5 minutes early.

To remove a bot **and** stop the calendar event re-creating one, unschedule the event with `DELETE /calendar/schedule/{event_id}` instead. See `calendar-schedule-bot`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `MEETSTREAM_API_KEY is not set` | `.env` missing or blank | `cp .env.example .env` and fill in the key. |
| API error 401 | No API key sent | Set `MEETSTREAM_API_KEY`. |
| API error 403 | Key rejected | Copy the whole key from the dashboard. |
| Bot is not in `list` | It already joined, was cancelled, or sits past the 100 row limit | `show <botId>` still queries live status by id. |
| API error 404 on patch or delete | Wrong bot id, or the bot already ran | Only future bots can be edited; check `list`. |
| API error 400 on patch | Join time in the past or not ISO 8601; the template checks both first, so usually a partial patch with no `scheduled_join_time` | Pass `--time` as well. |
| API error 429 | Rate limited | Back off and retry; `cancel-all` is sequential for this reason. |
| Rescheduled, but it joined at the old time anyway | The calendar event moved it back; push notifications keep bots aligned with their event | Unschedule the event if you want manual control. |
| `cancel-all` deleted less than expected | Bots that started while the loop ran can no longer be deleted | Re-run `list`. |

## Related

- [List scheduled bots](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/list-scheduled-bots)
- [Reschedule bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/reschedule-bot)
- [Delete scheduled bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/delete-scheduled-bot)
- [Scheduling bots](https://docs.meetstream.ai/guides/features/scheduling-bots)
- [Get bot status](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-status)
- [Error codes](https://docs.meetstream.ai/errors)
- Labs: [calendar-schedule-bot](../calendar-schedule-bot) creates the bots this CLI manages; [calendar-auto-schedule](../calendar-auto-schedule) creates them in bulk; [calendar-recurring-events](../calendar-recurring-events) creates one per occurrence of a series; [scheduled-bot-join-at](../scheduled-bot-join-at) schedules one-off bots with `join_at`.
