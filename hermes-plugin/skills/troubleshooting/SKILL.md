---
name: troubleshooting
description: >
  Diagnose MeetStream problems inside Hermes. Use when a meetstream tool is
  missing or fails, or the user says "MeetStream isn't working", "401", "403",
  "MEETSTREAM_API_KEY is not set", "the bot never joined", "the bot is silent",
  "transcript never arrives", "stuck on 202", or "duplicate bots". Read this
  before guessing at a cause.
---

# Troubleshooting MeetStream in Hermes

Every MeetStream error carries a `message`. Show it to the user - it usually
names the exact problem.

## Connection and auth

First check: call **`list_bots`**. A clean response means the key and the MCP
connection both work, and the problem is in a specific request.

| Symptom | Cause | Fix (the user runs it) |
|---|---|---|
| No `mcp__meetstream__*` tools at all | Plugin disabled, or session started before it was enabled | `hermes plugins enable meetstream`, then start a new session |
| `${MEETSTREAM_API_KEY} ... is not set` | Key missing from Hermes' environment | `hermes config set MEETSTREAM_API_KEY <key>`, new session |
| `401` / `Missing MeetStream API key` | Header never arrived | Same as above; check for a stray space or newline in the key |
| `403` | Key sent but rejected (wrong, revoked or truncated) | New key at https://app.meetstream.ai/api-keys |

Never ask the user to paste the key into the chat, and never print it.

## Status codes

| Code | Meaning | Action |
|---|---|---|
| `400` | Validation failed | Read `message`, fix the request. Never retry unchanged. |
| `404` | Unknown `bot_id` | Check the id; it may have been deleted. |
| `429` | Rate limited | Back off, then retry. |
| `500`/`503` | Transient | Retry with backoff. |
| `202` | **Not an error** - still processing | Poll again, with a cap. |
| `507` | **Not an error** - idempotent replay | Treat as success; it is the original bot. |

## "The bot never joined"

`get_bot_status`: `NotAllowed` means nobody admitted it from the waiting room,
`Denied` means a host refused it, `Error` means it crashed (create a fresh one).

## "The bot is in the call but silent"

Speech needs a MIA agent (`agent_config_id`); without one the bot only records
and chats. With one attached, see the `speak-in-meeting` skill's checklist.

## "The transcript never arrives"

1. Is the bot finished (`Stopped`/`Done`)? Transcripts are post-call.
2. Streaming provider? Then there is no post-call transcript; use `transcribe_audio`.
3. Read `segment.transcript`, not `segment.text`.

## "Duplicate bots"

Retries without an `idempotency_key`. Generate one UUID per intended bot and
reuse it on every retry.

## Reference

- [Errors](https://docs.meetstream.ai/errors)
- [Debugging bots](https://docs.meetstream.ai/guides/help/debugging-bots)
- [MCP server setup](https://docs.meetstream.ai/build-with-ai/meetstream-mcp-server)
