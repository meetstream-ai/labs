---
name: join-meeting
description: >
  Send a MeetStream bot into a live Zoom, Google Meet or Microsoft Teams
  meeting and follow it until it leaves. Use when the user says "join my
  meeting", "join this call", "send a bot to <meeting url>", "record this
  meeting", "take notes on this call", "is the bot in yet", "make the bot
  leave", or pastes a meeting link and asks for anything to happen in it.
  Covers create_bot, bot status and lifecycle, and removal.
---

# Join a meeting with a MeetStream bot

The MeetStream MCP server is connected as `meetstream`. In Hermes its tools are
named `mcp__meetstream__<tool>` (for example `mcp__meetstream__create_bot`).
Call them directly. Do not write HTTP client code, and do not use the terminal
or browser to join a meeting.

## The short path

1. **`create_bot`** with `meeting_link` and a `bot_name`. Keep the returned `bot_id`.
2. **`get_bot_status`** to follow it: `Joining` -> `InWaitingRoom` -> `InMeeting` -> `Recording`.
3. Interact while it is in the call (see the `meeting-chat` and `speak-in-meeting` skills).
4. **`remove_bot`** when the user wants it gone, or let the meeting end.
5. Afterwards, the `meeting-brief` skill covers summaries and transcripts.

## Creating the bot

Ask for the meeting link if the user has not given one. The field is
`meeting_link`, not `meeting_url`.

- `bot_name` - always set it to something the humans will recognise, e.g.
  "Hermes Notetaker". A nameless bot looks like an intruder.
- `bot_message` - a chat line posted the moment the bot joins. Good for
  "Hi, I'm an AI assistant recording this call for <user>."
- `agent_config_id` - attach a MIA voice agent so the bot can **talk**. See
  `speak-in-meeting`. Pass only this id; never add WebSocket fields.
- `record_video` - leave off unless the user asks for video. Transcripts,
  summaries and speaker timelines all work without it.
- `transcription_provider` - `deepgram` is a good English default. Streaming
  providers (`*_streaming`) produce **no** post-call transcript.
- `join_at` - ISO 8601 time to schedule a future join instead of waiting.
- `idempotency_key` - a UUID if you might retry; a retry returns the same bot.

Report the `bot_id` back to the user. Every later tool call needs it.

## Following the bot

Poll `get_bot_status` every 5-10 seconds with a cap (about 5 minutes for
admission). Tell the user when it is waiting to be admitted - Google Meet and
many Zoom/Teams rooms require a host to click "Admit".

| Status | Meaning | Tell the user |
|---|---|---|
| `InWaitingRoom` | In the lobby | Someone in the call needs to admit the bot. |
| `InMeeting` / `Recording` | In the call | Ready - chat and voice work now. |
| `NotAllowed` | Lobby timed out | Nobody admitted it. Offer to send a new bot. |
| `Denied` | Host rejected it | Do not retry automatically. |
| `Error` | Session crashed | Safe to create a fresh bot. |
| `Stopped` / `Done` | Left the call | Data is processing or ready. |

Do not create a second bot for the same meeting because the first is slow.
Check its status first. `list_bots` finds a bot you lost track of.

## Ending it

- **`remove_bot`** - the bot leaves now. Recordings and transcripts are kept.
- **`delete_bot_data`** - permanently erases media and transcripts. Irreversible.
  Only call it when the user explicitly asks to delete data, and confirm first.
  The tool itself requires `confirm: true`.

## Reference

- [Create your first bot](https://docs.meetstream.ai/guides/get-started/create-your-first-bot)
- [How bots work](https://docs.meetstream.ai/guides/introduction/how-bots-work)
- [create_bot API](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
