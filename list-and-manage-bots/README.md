# List, Filter and Remove Meeting Bots with the MeetStream API

List every meeting bot on your MeetStream account with `GET /bots`, filter and sort Zoom, Google Meet and Microsoft Teams bots into a table by status, and make an active bot leave its meeting with `GET /bots/{id}/remove_bot`.

```bash
npm install
cp .env.example .env   # then fill in MEETSTREAM_API_KEY
node index.js
```

## Prerequisites

- Node.js 18 or newer (built-in `fetch`)
- A MeetStream API key from https://app.meetstream.ai

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/list-and-manage-bots
npm install
cp .env.example .env   # then fill in MEETSTREAM_API_KEY
node index.js --help
```

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>` |
| `MEETSTREAM_API_BASE_URL` | no | API base URL (default `https://api.meetstream.ai/api/v1`) |

## Usage

```bash
node index.js                        # every bot, newest first
node index.js --active               # only bots still in a meeting
node index.js --status Recording     # exact bot_status match, case insensitive
node index.js --sort status          # created (default) | status | name | id
node index.js --limit 20
node index.js --json                 # normalised records as JSON
node index.js --remove bot_abc123    # make that bot leave now
```

Example output:

```
BOT ID                      STATUS          NAME                  WHEN              MEETING
--------------------------  --------------  --------------------  ----------------  ----------------------------------
bot_7f2c...                 Recording       Sales Notetaker       2026-08-23 14:02  https://meet.google.com/abc-defg…
bot_1a9d...                 Stopped         Standup Bot           2026-08-23 09:31  https://zoom.us/j/98765432100

2 of 2 bots shown, read over 1 page(s).

Breakdown by status:
  Recording           1  (still in a meeting)
  Stopped             1
```

## How it works

**Listing.** `GET /bots` returns a paginated envelope shaped `{ bots, hasNextPage, nextCursor }`. `src/bots.js` walks the pages, passing `nextCursor` back as the `cursor` query parameter, and stops on `hasNextPage: false`, a repeated cursor, or 20 pages, whichever comes first. A broken cursor can never turn into an infinite loop.

**Filtering and sorting are client side.** The list endpoint has no documented filter or sort parameters, so everything is done in memory after the fetch. For a handful of pages this is fine. If your account has tens of thousands of bots, treat this template as a starting point.

**Normalising.** Bot records carry different fields depending on how the bot was created: a scheduled bot has `join_at`, a finished one has timings, and the id arrives as `bot_id`. `normaliseBot()` maps all of that onto one shape and keeps the original under `raw`, so nothing is lost and nothing is assumed.

**Removing.** 

```http
GET /bots/{bot_id}/remove_bot
```

Yes, `GET`. This is the single most surprising thing in the bot API: the call that makes a bot leave a meeting is a GET, not a POST or a DELETE. The bot moves to `Leaving` and then `Stopped`.

## remove_bot is not delete

| | `GET /bots/{id}/remove_bot` | `DELETE /bots/{id}/delete` |
|---|---|---|
| What it does | Bot leaves the meeting now | Erases the bot's stored data |
| Recording kept | yes | no |
| Transcript kept | yes | no |
| Reversible | n/a, nothing was destroyed | no |
| Webhook | `bot.leaving`, then `bot.stopped` | `data_deletion` |

If you want to erase data, see [../delete-bot-data](../delete-bot-data). This one only pulls bots out of calls.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `MEETSTREAM_API_KEY is not set` | `.env` missing or empty | `cp .env.example .env` and add your key |
| 401 / 403 | 401 = no key sent, 403 = key rejected | Check the key for stray quotes or whitespace |
| Empty list | The account has no bots, or the key belongs to a different workspace | Check the workspace the key was created in |
| `--status Recording` returns nothing but the bot is in the meeting | Status strings are exact values (`Recording`, `InMeeting`, `InWaitingRoom`) | Run without a filter first and read the breakdown at the bottom |
| `--remove` returns 404 | Wrong bot id, or the bot already stopped | Removal only applies to a live session |
| `--remove` returns 200 but the bot is still in the call | Leaving is asynchronous | Poll `GET /bots/{id}/status` for `Leaving`, then `Stopped`; see [../bot-status-monitor](../bot-status-monitor) |

## Related

- [List bots](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/list-bots)
- [Remove bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/remove-bot)
- [Get bot status](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-status)
- [Delete bot data](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/delete-bot-data)
- [Debugging bots](https://docs.meetstream.ai/guides/help/debugging-bots)
- Related templates: [../bot-status-monitor](../bot-status-monitor), [../delete-bot-data](../delete-bot-data)
