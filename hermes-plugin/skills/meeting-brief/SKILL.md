---
name: meeting-brief
description: >
  Turn a MeetStream meeting into a brief or answer questions about it: AI
  summary, transcript, action items, decisions, talk-time, participants and
  recordings. Use when the user says "summarize that meeting", "what did we
  decide", "action items", "pull the transcript", "who talked the most", "what
  did <person> say", "download the recording", or points at a bot_id and asks
  anything about the conversation.
---

# Brief someone on a meeting

Pull real data before writing anything. Never summarize a meeting you have not
read. Tools are named `mcp__meetstream__<tool>` in Hermes and all take `bot_id`
(use `list_bots` if you do not have it).

## Fastest route

1. **`get_bot_summary`** - MeetStream's own AI summary. One call; try it first.
2. **`get_transcript`** - full transcript. Pass the `bot_id`; the tool resolves the
   transcript for you. `wait: true` polls until it is ready.
3. **`get_speaker_timeline`** - who spoke and when.
4. **`get_participants`** - attendee list.
5. **`get_media_urls`** - presigned audio/video/screenshot URLs (they expire).

## Reading the transcript correctly

Segments carry `speaker`, **`transcript`** (the text - not `text`), `start_time`
and `end_time`. Reading the wrong field produces an empty-looking brief.

If the transcript is not ready, retry a few times with a gap. If the bot used a
**streaming** provider (`*_streaming`, `meeting_captions`) there is never a
post-call transcript - say so, and offer `transcribe_audio` to generate one from
the stored audio.

## What a good brief contains

- **Outcome** - one or two sentences on what was settled.
- **Decisions** - each with who made it.
- **Action items** - owner and due date where stated.
- **Open questions** - raised and not resolved.
- **Participation** - talk-time shares if asked. The speaker timeline is in
  byte offsets, so report shares rather than invented minutes.

Attribute claims to speakers. Flag ambiguity instead of smoothing it over.

## Reference

- [Bot summary API](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-summary)
- [Post-call transcription](https://docs.meetstream.ai/guides/transcription-recordings/post-call-transcription)
- [Retrieve recordings](https://docs.meetstream.ai/guides/transcription-recordings/retrieve-recordings)
