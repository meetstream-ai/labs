# Send Chat Message

A CLI that posts chat messages into a live meeting as your MeetStream bot: one message on demand, or a timed announcement plan that fires at fixed offsets after the bot joins.

```bash
npm install
cp .env.example .env    # add MEETSTREAM_API_KEY
node index.js --bot-id <bot_id> --message "Recording has started"
```

## Prerequisites

- Node.js 18 or newer
- A MeetStream API key ([app.meetstream.ai](https://app.meetstream.ai))
- Either a bot already in a meeting (`--bot-id`) or a meeting link to send one into (`--meeting-link`)

No public URL, no tunnel, no webhook. This template is pure REST.

## Setup

1. `npm install`
2. `cp .env.example .env`
3. Put your key in `MEETSTREAM_API_KEY`.
4. Run one of the commands below.

## Usage

**One message into a bot that is already in the meeting**

```bash
node index.js --bot-id 5b0ff6e7-3cea-4c9f-a6b4-851c5f11cf4f \
  --message "Recording has started. Say so if you would prefer I stop."
```

**One message, delayed**

```bash
node index.js --bot-id <id> --message "Five minutes left" --after 300
```

**Announcement mode** creates a bot, waits until it is actually in the meeting, then fires each message at its offset:

```bash
node index.js \
  --meeting-link https://meet.google.com/abc-defg-hij \
  --announce "0:Hi everyone, I am recording this session|300:Halfway point|600:Wrapping up"
```

**Announcement plan from a file**

```bash
cp schedule.example.json schedule.json
node index.js --meeting-link https://meet.google.com/abc-defg-hij --schedule-file schedule.json
```

```json
[
  { "after_seconds": 0,   "message": "Hi everyone, recording has started." },
  { "after_seconds": 300, "message": "Five minutes in." }
]
```

**See the plan without touching the API**

```bash
node index.js --bot-id <id> --announce "0:one|30:two" --dry-run
```

### Options

| Option | Description |
|---|---|
| `--bot-id <id>` | Existing bot to talk through |
| `--meeting-link <url>` | Create a new bot for this meeting instead |
| `--bot-name <name>` | Display name for a newly created bot |
| `--message`, `-m <text>` | A single message |
| `--after <seconds>` | Delay before `--message` (default `0`) |
| `--announce <spec>` | Pipe-separated `seconds:text` entries |
| `--schedule-file <path>` | JSON array of `{ "after_seconds", "message" }` |
| `--wait-timeout <seconds>` | How long to wait for the bot to join (default `600`) |
| `--stay` | Leave a bot we created in the meeting when the plan finishes |
| `--dry-run` | Print the plan, call nothing |
| `-h`, `--help` | Usage |

Exactly one of `--bot-id` or `--meeting-link` is required, and at least one of `--message`, `--announce`, `--schedule-file`.

## How it works

The message call itself is one request:

```json
POST https://api.meetstream.ai/api/v1/bots/{bot_id}/send_message
Authorization: Token YOUR_API_KEY

{ "message": "Recording has started" }
```

Everything else is timing:

1. **Create a bot** (`--meeting-link` mode only) via `POST /bots/create_bot`.
2. **Wait for it to be live.** `GET /bots/{bot_id}/status` is polled every 3s until the status is `InMeeting` or `Recording`. A message sent while the bot is still `Joining` has nowhere to land. If the bot hits `Stopped`, `NotAllowed` (waiting-room timeout) or `Denied` (host refused) the run aborts with that reason.
3. **Fire the plan.** Offsets are absolute from the moment the bot went live, not cumulative: `0 / 300 / 600` sends at exactly those three points.
4. **Clean up.** A bot this CLI created is removed at the end via `GET /bots/{bot_id}/remove_bot` (yes, a GET), and also on Ctrl+C. `--stay` opts out. A bot you passed in with `--bot-id` is never removed.

A single failed send is logged and the plan continues. One rejected message should not cancel the rest of the announcements.

Requests carry an `Idempotency-Key`, so a retried send comes back as HTTP `507` and is treated as success rather than posting the message twice.

## Project structure

```
send-chat-message/
├─ index.js                 # entry point: parse, create/resolve bot, run the plan
├─ src/
│   ├─ cli.js               # argument parsing and schedule building
│   ├─ announcer.js         # waitForInMeeting + runSchedule
│   ├─ meetstream.js        # REST client (Token auth, retries, 507 handling)
│   └─ logger.js            # zero-dependency terminal output
├─ schedule.example.json
├─ .env.example
├─ package.json
└─ README.md
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | From the MeetStream dashboard |
| `BOT_NAME` | no | Default display name when creating a bot |
| `WAIT_TIMEOUT_SECONDS` | no | Default join wait, `600` |

## Related

There are two other ways to put text into a meeting, and they are not interchangeable:

| Want | Use |
|---|---|
| A message in the meeting chat, over REST | this template: `POST /bots/{id}/send_message` |
| A message in the meeting chat, over a live control socket | [`websocket-bot-control`](../websocket-bot-control): `sendmsg` / `sendchat` |
| An image or GIF in the meeting chat | [`send-image-bot`](../send-image-bot): `POST /bots/{id}/send_image` |

The WebSocket route is worth it when you are already holding a control channel open and want sub-second delivery or streaming partial text. For scheduled announcements, REST is simpler.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Missing MEETSTREAM_API_KEY` | Copy `.env.example` to `.env` and fill it in |
| `404` on send_message | Wrong bot id, or the bot has already left. Check `GET /bots/{bot_id}/status`. |
| `401` / `403` | The header is `Authorization: Token <key>`, not `Bearer`. Regenerate the key if it still fails. |
| Bot never reaches the meeting | Admit it from the waiting room, or raise `--wait-timeout` |
| `Bot reached terminal status "NotAllowed"` | It timed out in the lobby and gave up |
| Messages send but nobody sees them | Check the meeting platform's chat panel is open, and that the bot is a full participant rather than still in the lobby |

## Resources

- [Send message endpoint](https://docs.meetstream.ai/api-reference)
- [Create Bot endpoint](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [MeetStream docs](https://docs.meetstream.ai)
