# Send Chat Messages into Live Meetings with the MeetStream API

A CLI that posts chat messages into a live Zoom, Google Meet or Microsoft Teams meeting as your MeetStream bot, using `POST /bots/{bot_id}/send_message`: one message on demand, or a timed announcement plan that fires at fixed offsets after the bot joins. Pure REST, no webhook or tunnel needed.

```bash
npm install
cp .env.example .env    # add MEETSTREAM_API_KEY
node index.js --bot-id <bot_id> --message "Recording has started"
```

## What it does

1. Uses an existing bot (`--bot-id`) or creates one for `--meeting-link` with `POST /bots/create_bot`.
2. Polls `GET /bots/{bot_id}/status` every 3s until the bot is `InMeeting` or `Recording`; a message sent while it is still `Joining` has nowhere to land.
3. Sends each message at its offset with `POST /bots/{bot_id}/send_message`. A failed send is logged and the plan continues.
4. Removes a bot it created with `GET /bots/{bot_id}/remove_bot` when the plan finishes, and on Ctrl+C.

## Prerequisites

- Node.js 18 or newer
- A MeetStream API key ([app.meetstream.ai](https://app.meetstream.ai))
- Either a bot already in a meeting (`--bot-id`) or a meeting link to send one into (`--meeting-link`)

No public URL, no tunnel, no webhook. This template is pure REST.

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/send-chat-message
npm install
cp .env.example .env    # put your key in MEETSTREAM_API_KEY
node index.js --help
```

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `MEETSTREAM_API_KEY` | yes (except `--dry-run` and `--help`) | API key, sent as `Authorization: Token <key>`. |
| `BOT_NAME` | no | Default display name when this CLI creates a bot. Override with `--bot-name`. Default `MeetStream Labs Announcer`. |
| `WAIT_TIMEOUT_SECONDS` | no | Default join wait. Override with `--wait-timeout`. Default `600`. |
| `MEETSTREAM_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |
| `NO_COLOR` | no | Set to any value to disable ANSI colours in the log output. |

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

1. **Create a bot** (`--meeting-link` mode only) via `POST /bots/create_bot`, with `meeting_link`, `bot_name` and `automatic_leave` (`in_call_recording_timeout` at its 600 second minimum or above).
2. **Wait for it to be live.** `GET /bots/{bot_id}/status` is polled every 3s until the status is `InMeeting` or `Recording`. If the bot reaches `Stopped`, `NotAllowed` (waiting-room timeout), `Denied` (host refused) or a failure status (`FAILED` / `ERROR` / `Failed`, compared case-insensitively) the run aborts with that reason.
3. **Fire the plan.** Offsets are absolute from the moment the bot went live, not cumulative: `0 / 300 / 600` sends at exactly those three points.
4. **Clean up.** A bot this CLI created is removed at the end via `GET /bots/{bot_id}/remove_bot` (yes, a GET), and also on Ctrl+C. `--stay` opts out. A bot you passed in with `--bot-id` is never removed.

A single failed send is logged and the plan continues. One rejected message should not cancel the rest of the announcements.

Requests carry an `Idempotency-Key`, so a retried send comes back as HTTP `507` and is treated as success rather than posting the message twice. 429 and 5xx are retried with backoff (honouring `Retry-After`); 4xx is never retried.

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

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing MEETSTREAM_API_KEY` | No `.env`, or an empty key. | Copy `.env.example` to `.env` and fill it in. |
| `401` / `403` | No key was sent, or the key was rejected. | The header is `Authorization: Token <key>`, not `Bearer`. Regenerate the key if it still fails. |
| `404` on send_message | Wrong bot id, or the bot has already left. | Check `GET /bots/{bot_id}/status`. |
| `400` on create_bot | Bad `meeting_link`, or `in_call_recording_timeout` below 600. | Check the link. |
| Bot never reaches the meeting | It is waiting in the lobby. | Admit it from the waiting room, or raise `--wait-timeout`. |
| `Bot reached terminal status "NotAllowed"` | It timed out in the lobby and gave up. | Admit it faster next time. |
| `Bot reached terminal status "Denied"` | The host refused entry. | Ask the host to admit the bot. |
| `Provide exactly one of --bot-id or --meeting-link` | Both or neither were given. | Pass one. |
| Messages send but nobody sees them | The bot is not yet a full participant, or the chat panel is closed. | Check the platform's chat panel, and that the bot left the lobby. |

## Related

There are two other ways to put text into a meeting, and they are not interchangeable:

| Want | Use |
|---|---|
| A message in the meeting chat, over REST | this template: `POST /bots/{id}/send_message` |
| A message in the meeting chat, over a live control socket | [`websocket-bot-control`](../websocket-bot-control): `sendmsg` / `sendchat` |
| An image or GIF in the meeting chat | [`send-image-bot`](../send-image-bot): `POST /bots/{id}/send_image` |

The WebSocket route is worth it when you are already holding a control channel open and want sub-second delivery or streaming partial text. For scheduled announcements, REST is simpler.

- [Send message](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/send-message)
- [Chat and visuals](https://docs.meetstream.ai/guides/features/chat-and-visuals)
- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [Get bot status](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-status)
- [Remove bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/remove-bot)
- [Automatic leave configuration](https://docs.meetstream.ai/guides/features/automatic-leave-configuration)
