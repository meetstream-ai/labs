# chat-responder

A MeetStream bot that sits in a meeting and answers commands typed in the
meeting chat:

| Command | Reply |
|---|---|
| `!help` | the list of commands |
| `!agenda` | the contents of the local agenda file (`AGENDA_PATH`) |
| `!time` | how long the meeting has been running |

A command is recognised anywhere in a message (`hey bot, !agenda please`), and
each message produces at most one reply.

## How it works

The service polls `GET /bots/{bot_id}/get_chats` every `POLL_INTERVAL_SECONDS`
and answers with `POST /bots/{bot_id}/send_message`. Both calls are outbound, so
there is no inbound endpoint to expose and nothing to open in a security group.

Cost: one small JSON GET per bot per interval (5s default ≈ 0.2 req/s per bot),
no media download, no transcription. Raise the interval to trade reply latency
for request volume when running many bots. Bots created by `join` record audio
only (`video_required: false`) with 24h retention.

## Setup

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e ".[dev]"
cp .env.example .env     # then fill in MEETSTREAM_API_KEY
.venv/bin/chat-responder check
```

## Use

```bash
# 1. put a bot in a meeting (prompts before joining; --yes skips)
.venv/bin/chat-responder join "https://meet.google.com/abc-defg-hij"

# 2. put the printed bot id in .env as MEETSTREAM_BOT_ID, then watch the chat
.venv/bin/chat-responder run

# single poll, useful for a smoke test
.venv/bin/chat-responder run --once
```

## Handling untrusted chat

Anyone in the meeting can type, so inbound text is treated as hostile:

- messages are truncated to `MAX_MESSAGE_CHARS` and stripped of control,
  zero-width and bidi characters before parsing
- commands match only as standalone `!word` tokens; `!!help`, `a!help.com` and
  `!helpme` do not trigger anything
- user text is never echoed back, and the agenda path comes from config only,
  so chat cannot steer a file read
- replies are throttled per sender (`SENDER_COOLDOWN_SECONDS`) and overall
  (`MAX_REPLIES_PER_MINUTE`)
- the bot ignores its own chat lines, so it cannot answer itself
- replies are deduped by message id (or a content hash when the API omits one),
  and the backlog present at startup is never answered
- raw chat payloads are logged at DEBUG only

## Tests

```bash
.venv/bin/python -m pytest
```

No network and no API key needed: the HTTP layer is driven through a fake
session, and the responder through a fake client.

## Note on `get_chats`

The MeetStream docs list `GET /bots/{bot_id}/get_chats` but do not pin its
response schema, so `client.normalize_chats` does not assume one. It searches
the payload for the first list of things that look like chat lines (text plus a
sender, id or timestamp), which covers a bare list, any wrapper key at any
depth, a map keyed by message id, and a single unwrapped message. Fields are
read through the common key spellings, including when a field is an object
(`{"message": {"text": "..."}}`).

An earlier version only looked under six fixed wrapper keys with the text as a
top-level string, which is why a live run saw zero messages while people were
typing.

If a payload still comes back unreadable, `normalize_chats` logs a WARNING with
the **key names** it saw (never the values - those stay at DEBUG), once per
shape per process. That line names the exact spelling to add. The real shape is
still unverified against a live meeting; pin the parser to it once it is known.

## Run against the local mock (no API key, no meeting)

[`../mock-meetstream`](../mock-meetstream) is a small offline stand-in for the MeetStream API. It answers with the same request and response shapes, and it plays a short meeting (lifecycle webhooks, live transcript, post-call files) when asked. `mock_e2e.py` starts the mock, runs this app against it, and prints PASS or FAIL.

```bash
python3 -m venv .venv && .venv/bin/pip install -U pip && .venv/bin/pip install -e ".[dev]"
python3 mock_e2e.py
```
