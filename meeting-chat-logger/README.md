# Export Meeting Chat Messages with the MeetStream API

Export the in-meeting chat a MeetStream meeting bot captured on Zoom, Google Meet or Microsoft Teams to JSON and Markdown, with authors and timestamps, using `GET /bots/{bot_id}/get_chats`. Works on a bot that already ran, or sends a new bot into a live meeting and waits for it to finish.

```bash
cp .env.example .env   # add your MEETSTREAM_API_KEY and a BOT_ID or MEETING_LINK
npm install
node index.js
```

## What it does

Reads `GET /bots/{bot_id}/get_chats` and writes two files:

- **`output/chat-<bot_id>.json`** - every message, normalised, plus the
  untouched API response and a record of how the normalisation was done
- **`output/chat-<bot_id>.md`** - a readable transcript: a per-author message
  count, then each message with its author and timestamp

Plus a console preview so you can see it worked without opening a file.

Two modes, chosen by your `.env`:

| You set | What happens |
| --- | --- |
| `BOT_ID` | Export chat from a meeting a bot already recorded. Nothing is created. |
| `MEETING_LINK` | Create a bot, wait for the meeting to end, then export. |

## Prerequisites

- Node.js 18 or newer (uses the built-in `fetch`)
- A MeetStream API key - <https://app.meetstream.ai>
- A bot that has finished a meeting, or a live meeting link to send one into

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/meeting-chat-logger
npm install
cp .env.example .env   # then set MEETSTREAM_API_KEY and BOT_ID or MEETING_LINK
node index.js
```

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>` |
| `BOT_ID` | one of the two | Export chat from a bot that already ran; wins over `MEETING_LINK` |
| `MEETING_LINK` | one of the two | Zoom, Google Meet or Teams link; a new bot is created and the program waits for it to finish |
| `BOT_NAME` | no | Display name when creating a bot (default `MeetStream Chat Logger`) |
| `TRANSCRIPT_LANGUAGE` | no | Deepgram language for the post-call transcript (default `en`) |
| `RETENTION_HOURS` | no | Timed retention for the new bot's data (default `72`; API default is 30 days / 720 h) |
| `WAITING_ROOM_TIMEOUT` | no | Seconds to wait in the lobby (default `600`) |
| `EVERYONE_LEFT_TIMEOUT` | no | Seconds to stay after everyone left (default `600`) |
| `IN_CALL_RECORDING_TIMEOUT` | no | Max recording seconds (default `14400`; API floor is `600`) |
| `IDEMPOTENCY_KEY` | no | `Idempotency-Key` UUID for `create_bot`; a replay returns 507, treated as success |
| `STATUS_POLL_INTERVAL_MS` | no | Delay between `GET /bots/{id}/status` polls (default `15000`) |
| `STATUS_POLL_MAX_ATTEMPTS` | no | Cap on status polls (default `240`) |
| `CHAT_POLL_INTERVAL_MS` | no | Delay between `get_chats` polls while it answers 202 (default `10000`) |
| `CHAT_POLL_MAX_ATTEMPTS` | no | Cap on `get_chats` polls (default `12`) |
| `OUTPUT_DIR` | no | Where the JSON and Markdown files go (default `./output`) |
| `PREVIEW_LIMIT` | no | Messages shown in the terminal preview (default `20`) |
| `REQUEST_TIMEOUT_MS` | no | Per-request timeout (default `30000`) |
| `MAX_RETRIES` | no | Retries for 429/5xx (default `3`); 4xx is never retried |
| `RETRY_BASE_DELAY_MS` | no | Base backoff delay (default `1000`) |
| `MEETSTREAM_BASE_URL` | no | API base URL (default `https://api.meetstream.ai/api/v1`) |

**Recording defaults.** This template records audio only: it sends `video_required: false` explicitly, because the REST API treats an omitted `video_required` as true. If you enable video, also send `recording_config.video_layout: "speaker_view"` (the API default is `grid_view`); use `grid_view` only when you want the composited mosaic of everyone. Per-participant video (`video_separate_streams`) is never enabled implicitly.

## About the response shape

The API reference documents `get_chats` as "in-meeting chat messages captured
by the bot" without publishing a field-level schema, and the keys differ by
meeting platform - Google Meet, Zoom and Teams each expose chat differently.

Guessing one shape and hardcoding it would quietly drop messages, so
`src/normalize.js` does something more careful:

1. Finds the message list whether the response is a bare array or an object
   wrapping one (`chats`, `messages`, `data`, …, then any array-valued key).
2. Detects the author, text, timestamp and recipient fields from a list of
   candidate key names, including nested forms like `{ sender: { name } }`.
3. Keeps the original object on every message under `raw`.
4. **Reports which keys it used**, and lists any fields it did not map, so you
   can see exactly what happened:

```
Field mapping
=============

Message list found under: chats
  author    -> senderName
  text      -> message
  timestamp -> timestamp
  recipient -> not found
  other fields present: deviceId, messageId
```

If your account returns a key name that is not in the candidate lists, add it
to `AUTHOR_KEYS` / `TEXT_KEYS` / `TIME_KEYS` in `src/normalize.js` - that is
the only change needed. Nothing is lost in the meantime: the raw response is
always in the JSON export.

## How it works

```
index.js               entry point, polling, file writing
src/client.js          MeetStream HTTP client (Token auth, 202/507 handling, retries)
src/session.js         resolve BOT_ID, or create a bot and wait for it to finish
src/normalize.js       response -> normalised messages + a mapping report
src/exporters.js       messages -> JSON, Markdown, console preview
src/format.js          table / timestamp helpers
```

Meeting metadata for the Markdown header (`MeetingLink`, `Platform`,
`StartTime`, `EndTime`) comes from `GET /bots/{bot_id}/detail` → `bot_details`.

## Output

`output/chat-<bot_id>.md`:

```markdown
# Meeting chat log

- **Bot:** `305e708e-d0b5-4081-b982-fb9af84a716b`
- **Platform:** gmeet
- **Started:** 2026-05-26 10:04:11Z
- **Messages:** 14

## Who wrote what

| Author | Messages |
| --- | ---: |
| Alice | 9 |
| Bob | 5 |

## Transcript

### **Alice** · 2026-05-26 10:06:31Z

here's the doc we were talking about
```

`output/chat-<bot_id>.json` carries the same messages plus `raw_response`, so
it round-trips losslessly into your own pipeline.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `MEETSTREAM_API_KEY is not set` | `.env` missing or empty | `cp .env.example .env` and paste your key |
| HTTP 401 / 403 | 401 = no key sent, 403 = key inactive for this workspace | Check the key for stray quotes or whitespace |
| HTTP 400 on `create_bot` | Bad `MEETING_LINK`, or `IN_CALL_RECORDING_TIMEOUT` below 600 | Use a full meeting URL; keep the timeout at 600 or more |
| HTTP 404 | Wrong bot id, or the data expired via its retention window | Check the id with `GET /bots`; re-record if retention has passed |
| Still 202 after the poll cap | Processing has not finished | Re-run later with `BOT_ID`, or raise `CHAT_POLL_MAX_ATTEMPTS` |
| Bot ended `NotAllowed` / `Denied` | Never admitted, or the host refused | Nothing was captured; admit the bot from the lobby next time |
| "No chat messages were captured" | Usually nobody used the chat; most platforms only expose messages sent after the bot joined | Nothing to fix |
| "No text field was recognised" | Your account uses a key name not in `TEXT_KEYS` | Check the `other fields present` line and add it to `src/normalize.js` |
| Authors all show as "Unknown" | Same cause, for `AUTHOR_KEYS` | The raw objects in the JSON export show the real key |
| Timestamps show as `-` | No recognised time field on the messages | Message order is still preserved |

## Related

- [Get bot chats](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-chats)
- [Chat and visuals](https://docs.meetstream.ai/guides/features/chat-and-visuals)
- [Get bot details](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-details)
- [Usage and retention](https://docs.meetstream.ai/guides/features/usage-and-retention)
- [Error codes](https://docs.meetstream.ai/errors)
- Related templates: [../send-chat-message](../send-chat-message), [../transcript-fetcher](../transcript-fetcher)
