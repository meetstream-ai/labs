# Meeting Chat Logger

Export the in-meeting chat a MeetStream bot captured to JSON and Markdown,
with authors and timestamps.

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

| Symptom | Cause and fix |
| --- | --- |
| `MEETSTREAM_API_KEY is not set` | `cp .env.example .env` and paste your key. |
| HTTP 401 / 403 | No key sent, or the key is inactive for this workspace. |
| HTTP 404 | Wrong bot id, or the data expired via its retention window. |
| Still 202 after the poll cap | Processing has not finished. Re-run later with `BOT_ID`, or raise `CHAT_POLL_MAX_ATTEMPTS`. |
| "No chat messages were captured" | Usually nobody used the chat. Note that most platforms only expose messages sent *after* the bot joined. |
| "No text field was recognised" | Your account uses a key name not in `TEXT_KEYS`. Check the `other fields present` line and add it to `src/normalize.js`. |
| Authors all show as "Unknown" | Same cause, for `AUTHOR_KEYS`. The raw objects in the JSON export will show the real key. |
| Timestamps show as `-` | No recognised time field on the messages. Message order is still preserved. |

## Resources

- [MeetStream docs](https://docs.meetstream.ai)
- [API reference](https://docs.meetstream.ai/api-reference)
