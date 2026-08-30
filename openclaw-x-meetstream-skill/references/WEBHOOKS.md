# MeetStream webhook lifecycle

The current callback envelope uses `event` for the event name:

```json
{
  "event": "bot.inmeeting",
  "bot_id": "...",
  "bot_status": "InMeeting",
  "message": "...",
  "status_code": 200,
  "custom_attributes": {}
}
```

## Lifecycle

```text
bot.joining
  -> bot.in_waiting_room (when applicable)
  -> bot.inmeeting
  -> bot.recording
  -> bot.leaving
  -> bot.stopped
```

`bot.stopped` is terminal for meeting participation. Inspect `bot_status` for
the reason: `Stopped`, `NotAllowed`, `Denied`, or `Error`. `bot.error` is a
non-terminal streaming-provider error; the bot may continue.

For post-call providers, processing continues:

```text
manifest.completed
  -> audio.processed
  -> transcription.processed | transcription.failed
  -> video.processed (when video was requested)
  -> bot.done
```

Streaming-only providers do not follow the normal transcription/bot.done path.
Their live webhook output is the source of truth.

## Handler rules

- Return HTTP 2xx quickly; queue slow work.
- Make processing idempotent because duplicate deliveries are always possible
  in distributed systems.
- Key state by `bot_id` and validate that follow-up events belong to the
  intended session.
- Do not expect `transcript_id` in webhooks. Resolve it from the create response,
  `GET /bots/{id}/detail`, or `GET /bots/{id}/transcriptions`.
- Keep webhook payloads and meeting content out of public logs.
