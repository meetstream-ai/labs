# scheduled-bot-join-at

Schedule a bot for a future meeting with `join_at`, list what is scheduled, move it with `PATCH /calendar/scheduled_bots/{bot_id}`, and cancel it with `DELETE /calendar/scheduled_bots/{bot_id}`.

```bash
npm install
cp .env.example .env   # then fill in MEETSTREAM_API_KEY and MEETING_LINK
node index.js create --in 30
node index.js list
```

## Prerequisites

- Node.js 18 or newer
- A MeetStream API key from https://app.meetstream.ai
- A meeting link for a meeting that has not started yet

## Usage

```bash
node index.js create --in 30                      # join in 30 minutes
node index.js create --at 2026-07-02T15:00:00Z    # join at an exact time
node index.js list                                # upcoming scheduled bots
node index.js list --all                          # include past join_at times
node index.js reschedule bot_abc123 --in 90       # move it
node index.js reschedule bot_abc123 --at 2026-07-02T16:30:00Z
node index.js cancel bot_abc123                   # cancel before it joins
```

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

The response is the usual `{ bot_id, transcript_id, meeting_url, status }`. The bot then sits idle until `join_at`, at which point it runs the normal lifecycle: `Joining`, `InWaitingRoom`, `InMeeting`, `Recording`, `Leaving`, `Stopped`.

## Listing scheduled bots

There is no dedicated "list scheduled bots" endpoint. `list` reads `GET /bots`, which is paginated as `{ bots, hasNextPage, nextCursor }`, and keeps the records that carry a `join_at`. By default it shows only future times. `--all` includes past ones, which is how you check whether yesterday's scheduled bot actually ran.

## Rescheduling and cancelling

Both live under `/calendar`, and both work on any scheduled bot, whether or not it came from a connected calendar.

```http
PATCH /calendar/scheduled_bots/{bot_id}
{ "join_at": "2026-07-02T16:30:00Z" }
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

## Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MEETSTREAM_API_KEY` | yes | | From https://app.meetstream.ai |
| `MEETING_LINK` | for `create` | | Full Zoom / Meet / Teams URL |
| `BOT_ID` | no | | Default target for `reschedule` and `cancel` |
| `BOT_NAME` | no | `Scheduled Bot` | Display name in the meeting |
| `VIDEO_REQUIRED` | no | `false` | `true` records video too |
| `MEETSTREAM_API_BASE_URL` | no | production | Override for testing |

## Troubleshooting

**`--at is not a valid date`** - use ISO 8601 with an explicit zone, for example `2026-07-02T15:00:00Z`. A bare `2026-07-02 15:00` is ambiguous and gets parsed inconsistently.

**"That time is in the past"** - the bot will try to join immediately. Check whether you meant local time and forgot the `Z`, which makes a UTC timestamp look like a local one.

**`404` on reschedule or cancel** - the bot already joined, was already cancelled, or the id is wrong. Run `node index.js list --all` to see what actually exists.

**The bot never joined** - the meeting link expired, or the meeting was moved. `join_at` only controls when the bot dials in, it does not validate that the meeting still exists at that time.

**Nothing in `list` but you just scheduled one** - the record may not carry `join_at` under the key this filter expects. Run `node index.js list --all`, and use the `list-and-manage-bots` template with `--json` to see the raw records.
