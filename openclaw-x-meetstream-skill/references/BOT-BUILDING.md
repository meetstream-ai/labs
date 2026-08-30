# MeetStream bot-building manual

This manual is distilled from the official MeetStream Claude plugin, MeetStream
MCP server, Labs examples, and the live OpenAPI document at
<https://docs.meetstream.ai/openapi.json>. Use it when designing a bot; use the
tested scripts in `../scripts/` for supported operations.

## Pick the smallest bot pattern

| Goal | Recommended pattern |
| --- | --- |
| Join and record | Basic bot, audio-only unless video is required |
| Post-call notes | Post-call transcription (`deepgram` is the general default) |
| Live captions | Streaming transcription plus a public HTTPS webhook |
| Conversational meeting agent | Existing MIA configuration attached by `agent_config_id` |
| Per-person recording | Enable separate audio/video streams at creation |
| Hands-free scheduled meetings | Connect Google Calendar, then schedule selected events |
| Custom real-time media application | Build a separate WebSocket bridge from the official Labs patterns |

## Before creating a real bot

1. Run `scripts/doctor.sh`.
2. Obtain an actual authorized Meet/Zoom/Teams URL; never fabricate one.
3. Decide whether the bot needs video. Audio-only is cheaper and simpler.
4. Decide between post-call transcription and streaming transcription.
5. Choose retention deliberately; shorter retention reduces stored sensitive data.
6. Use a UUID idempotency key when an automated workflow may retry.
7. Add a lifecycle callback for production workflows.

## Creation recipes

Basic recording bot:

```bash
scripts/send-bot.sh --link "<meeting-url>" --name "Meeting Bot" --no-video
```

Post-call notetaker:

```bash
scripts/send-bot.sh \
  --link "<meeting-url>" \
  --name "Meeting Notetaker" \
  --no-video \
  --transcription deepgram \
  --language en \
  --retention-hours 24 \
  --idempotency-key "<uuid>"
```

Live transcript bot:

```bash
scripts/send-bot.sh \
  --link "<meeting-url>" \
  --name "Live Caption Bot" \
  --no-video \
  --transcription deepgram_streaming \
  --live-transcript "https://your-service.example/transcripts"
```

Hosted MIA agent:

```bash
scripts/send-bot.sh \
  --link "<meeting-url>" \
  --name "Meeting Assistant" \
  --agent-id "<agent-config-id>"
```

For MIA, pass only `agent_config_id`. Do not add `socket_connection_url` or
`live_audio_required`; those fields are for a custom bridge hosted by the
developer, not MeetStream's hosted MIA runtime.

## Provider behavior

- `deepgram`, `assemblyai`, `sarvam`, `meetstream`, and `jigsawstack` are
  post-call providers and can produce a fetchable transcript.
- `deepgram_streaming`, `assemblyai_streaming`, and `meeting_captions` are
  streaming-oriented. Treat the live webhook as the canonical record; do not
  wait indefinitely for `bot.done` or a normal post-call transcript.
- Provider language formats differ: Deepgram commonly uses `en`, AssemblyAI
  `en_us`, and Sarvam `en-IN`.

## After the meeting

```bash
scripts/bot-data.sh detail <bot-id>
scripts/get-transcript.sh <bot-id>
scripts/bot-data.sh summary <bot-id>
scripts/bot-data.sh participants <bot-id>
scripts/bot-data.sh chats <bot-id>
scripts/bot-data.sh audio <bot-id>
```

Media URLs are short-lived presigned links. Treat transcripts, participant
lists, chat, and recordings as sensitive meeting data.

## When to use a separate application

The shell skill is ideal for lifecycle operations and read-only artifacts.
Use a dedicated Node.js or Python service when the bot needs:

- a webhook receiver with durable event storage;
- real-time transcript processing;
- live audio or fMP4 video WebSocket decoding;
- bidirectional audio playback or interrupt handling;
- a production database, email delivery, CRM actions, or multi-tenant OAuth.

Start from the official examples:

- <https://github.com/meetstream-ai/claude-plugin>
- <https://github.com/meetstream-ai/meetstream-mcp>
- <https://github.com/meetstream-ai/labs>

Keep credentials in environment variables or a secret manager, return HTTP 2xx
from webhook handlers quickly, process events asynchronously and idempotently,
and correlate everything by `bot_id` plus custom attributes.
