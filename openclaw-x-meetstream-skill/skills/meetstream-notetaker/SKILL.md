---
name: meetstream-notetaker
description: Launch and operate MeetStream post-call notetakers, then retrieve transcripts, summaries, participants, chat, and recordings.
homepage: https://docs.meetstream.ai
metadata: { "openclaw": { "emoji": "📝", "requires": { "bins": ["curl", "jq"] }, "primaryEnv": "MEETSTREAM_API_KEY" } }
---

# MeetStream Notetaker

For a normal notetaker, use:

```bash
{baseDir}/../meetstream/scripts/send-bot.sh --link "<meeting-url>" --name "Meeting Notetaker" --no-video --transcription deepgram --retention-hours 24 --idempotency-key "<uuid>"
```

Do not launch without a real authorized meeting URL. Keep the returned `bot_id`.
After `transcription.processed`, fetch the transcript with
`{baseDir}/../meetstream/scripts/get-transcript.sh <bot-id>`. Use the core
`bot-data.sh` for the
summary, participants, chats, speaker timeline, and short-lived media URLs.
Streaming providers are for live delivery and may not yield a normal post-call
transcript; consult `{baseDir}/../meetstream/references/WEBHOOKS.md`.
