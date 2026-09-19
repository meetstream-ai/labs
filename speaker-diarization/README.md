# Speaker Diarization and Talk-Time Stats with the MeetStream API

Run a MeetStream meeting bot in a Zoom, Google Meet or Microsoft Teams meeting with Deepgram diarization (`diarize: true`), then post-process the transcript into clean per-speaker turns with a talk-time breakdown. Also works on any diarized transcript a bot already produced, by `bot_id` or `transcript_id`.

```bash
cp .env.example .env      # add MEETSTREAM_API_KEY
npm install
node index.js https://meet.google.com/xxx-xxxx-xxx
```

## What it does

Diarization answers "who said this". Turning it on is one field:

```json
{
  "recording_config": {
    "transcript": {
      "provider": { "deepgram": { "model": "nova-3", "language": "en", "diarize": true } }
    }
  }
}
```

The raw output is still segment-level, and one person talking for thirty seconds usually arrives as several segments. This template does the part the API leaves to you: merge those into turns, attribute anything the API left unlabelled, and produce a transcript a human can read plus a talk-time breakdown.

Example output:

```
Speaker    Turns    Words       Time  share of talk time
------------------------------------------------------------
Alice         14      612      04:31   58%  ##############
Bob            9      284      02:11   28%  #######
Speaker 2      4       97      01:05   14%  ###

[00:12 - 00:31]  Alice
    Thanks everyone for joining. I want to walk through the pricing
    changes before we get into the roadmap.

[00:33 - 00:41]  Bob
    Sounds good. Is this the version you sent on Friday?
```

## Prerequisites

- Node.js 18 or newer (uses built-in `fetch`)
- A MeetStream API key from [app.meetstream.ai](https://app.meetstream.ai)
- A live meeting URL, or a finished bot to post-process

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/speaker-diarization
npm install
cp .env.example .env      # set MEETSTREAM_API_KEY
node index.js https://meet.google.com/xxx-xxxx-xxx
```

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>`. |
| `MEETING_LINK` | mode 1 | Meeting to send a diarized bot into. The first CLI argument overrides it. |
| `BOT_ID` | mode 2 | Post-process a bot that already ran. `--bot <id>` overrides it. |
| `TRANSCRIPT_ID` | mode 3 | Post-process a transcript directly; skips every lookup. |
| `DEEPGRAM_MODEL` | no | Deepgram model. Default `nova-3`. |
| `LANGUAGE` | no | Deepgram `language` code. Default `en`. |
| `MAX_TURN_GAP_SECONDS` | no | Same-speaker gap that starts a new turn. Default `8`. |
| `BOT_NAME` | no | Display name in the meeting. Default `MeetStream Labs Bot`. |
| `CALLBACK_URL` | no | Lifecycle webhook URL. |
| `RETENTION_HOURS` | no | `recording_config.retention.hours`. Default `24` here; the API default when omitted is 720. |
| `STATUS_POLL_INTERVAL_MS` | no | Delay between `GET /bots/{id}/status` polls. Default `15000`. |
| `MAX_STATUS_POLLS` | no | Status poll cap. Default `240`. |
| `MAX_POLL_ATTEMPTS` | no | Cap on `get_transcript` polls while the API answers 202. Default `36`. |
| `POLL_INTERVAL_MS` | no | Delay between transcript polls. Default `5000`. |
| `OUTPUT_DIR` | no | Where the three output files are written. Default `transcripts`. |
| `MEETSTREAM_API_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |

## Run

Three modes:

```bash
# 1. Send a diarized bot to a live meeting, wait, then process
node index.js https://meet.google.com/xxx-xxxx-xxx

# 2. Post-process a bot that already ran
node index.js --bot <bot_id>

# 3. Post-process a transcript you already have the id for
TRANSCRIPT_ID=<transcript_id> node index.js
```

Modes 2 and 3 make no assumption that the bot was created by this template - any diarized transcript works.

Three files land in `transcripts/`:

| File | Contents |
|---|---|
| `<transcript_id>-raw.json` | The untouched API response |
| `<transcript_id>-turns.json` | Merged turns plus per-speaker stats, for downstream code |
| `<transcript_id>-speakers.txt` | The readable speaker-attributed transcript |

## How it works

A diarized segment carries speaker information in two places:

```json
{
  "speaker": "Alice",
  "transcript": "Can you walk me through pricing?",
  "start_time": 12.4,
  "end_time": 15.1,
  "words": [
    { "word": "Can", "punctuated_word": "Can", "start": 12.4, "end": 12.6,
      "confidence": 0.99, "speaker": 0, "speaker_confidence": 0.98 }
  ]
}
```

- **`segment.speaker`** - a display name when MeetStream can map the diarized speaker to a meeting participant, otherwise a numeric index.
- **`segment.words[].speaker`** - the per-word speaker index, with `speaker_confidence`.

Note that the segment text is in **`transcript`**, not `text`. That mistake produces an empty transcript with no error.

`src/diarize.js` uses both signals:

1. **`enrichSpeakers()`** - for any segment with no usable `speaker`, take the majority `words[].speaker` index and label it `Speaker 0`, `Speaker 1`, and so on. It also averages `speaker_confidence` across the segment's words so you can see how sure the model was.
2. **`buildTurns()`** - merge consecutive same-speaker segments into one turn. A turn also ends when the same speaker resumes after a gap longer than `MAX_TURN_GAP_SECONDS` (default 8), so a long pause reads as a new turn rather than one endless paragraph.
3. **`speakerStats()`** - per speaker: turn count, word count, speaking seconds, and share of talk time. Share is computed from durations when `start_time` / `end_time` are present, and falls back to word count when they are not. The output labels which basis was used.

The rest of the flow: `POST /bots/create_bot` with an `Idempotency-Key` (a replay answers 507 and is treated as success), poll `GET /bots/{id}/status` to a terminal status, resolve `transcript_id` from the create response or `GET /bots/{id}/detail` / `GET /bots/{id}/transcriptions` (it is never in a webhook), then `GET /transcript/{transcript_id}/get_transcript` with a capped 202 poll.

### Diarization across providers

This template uses Deepgram, which is the most common choice. Every post-call provider except `meetstream` supports speaker separation, under its own field name:

| Provider | Field |
|---|---|
| `deepgram` | `diarize: true` |
| `assemblyai` | `speaker_labels: true` |
| `sarvam` | `with_diarization: true` |
| `jigsawstack` | `by_speaker: true` |
| `meetstream` | not available |

The post-processing in `src/diarize.js` is provider-agnostic: it works on MeetStream's normalised `speaker` + `transcript` segments, so switching provider only changes which field you set at bot creation. See [multi-provider-transcription](../multi-provider-transcription).

### Diarization vs per-participant audio

Diarization is a **model inference**: the engine clusters voices in a single mixed audio track and guesses how many distinct people there are. It is very good, and it is not perfect. Cross-talk, similar-sounding voices, and one person on a poor connection all degrade it, and a speaker index can drift between clusters mid-meeting.

If you need attribution that is correct by construction rather than by inference, use **per-participant audio streams** (`audio_separate_streams: true`) instead. Each participant is recorded on their own track, so attribution comes from the platform, not from a model. See the [per-participant-audio-recorder](../per-participant-audio-recorder) template.

Rough guide: diarization for summaries, coaching, and analytics; per-participant streams for compliance, legal records, and anything a dispute might turn on.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `MEETSTREAM_API_KEY is not set` | No `.env`, or an empty key. | `cp .env.example .env` and paste your key. |
| HTTP 401 / 403 | No key was sent, or the key was rejected. | The header is `Authorization: Token <key>`; regenerate the key if 403 persists. |
| HTTP 404 on `get_transcript` | Wrong `transcript_id`, or the recording expired via its retention window. | Check `GET /bots/{bot_id}/transcriptions`. |
| Every segment is `Unknown speaker` | The bot ran without `diarize: true`. | Re-run the audio with [re-transcribe-audio](../re-transcribe-audio) (`PROVIDER=deepgram DIARIZE=true`), or send a new bot with this template. |
| Speakers are `Speaker 0` / `Speaker 1` rather than names | Diarization identified distinct voices but MeetStream could not map them to named participants. | Cross-reference `GET /bots/{bot_id}/get_participants` or `GET /bots/{bot_id}/get_speaker_timeline`. |
| More speakers than people in the meeting | Over-clustering: cross-talk, background noise, or one person switching devices. | Better audio is the only real fix. |
| Two people merged into one speaker | Under-clustering: similar voices, or one person barely spoke. | Consider per-participant audio streams. |
| Turns are one giant block per speaker | The gap threshold is too generous. | Lower `MAX_TURN_GAP_SECONDS` to split more aggressively. |
| Talk-time shows `00:00` for everyone | The segments came back without `start_time` / `end_time`. | The share falls back to word count; the table says which basis it used. |
| HTTP 202 until the retry cap | Still transcribing, or the bot used a `*_streaming` provider (no post-call transcript at all). | Raise `MAX_POLL_ATTEMPTS`, or re-transcribe with a post-call provider. |
| Bot status ends at `NotAllowed` / `Denied` | Never admitted from the waiting room / host refused. Nothing was recorded. | Admit the bot, or ask the host to allow it. |

## Related

- [Diarization](https://docs.meetstream.ai/guides/transcription-recordings/diarization)
- [Deepgram provider](https://docs.meetstream.ai/guides/transcription-recordings/providers/deepgram)
- [Participants and speaker timeline](https://docs.meetstream.ai/guides/features/participants-and-speaker-timeline)
- [Per-participant audio](https://docs.meetstream.ai/guides/transcription-recordings/per-participant-audio)
- [Get transcription](https://docs.meetstream.ai/api-reference/api-endpoints/transcription/get-transcription)
- [Get speaker timeline](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-speaker-timeline)
- Sibling templates: [multi-provider-transcription](../multi-provider-transcription) has the diarization field for every provider; [re-transcribe-audio](../re-transcribe-audio) adds diarization to a bot that already ran; [per-participant-audio-recorder](../per-participant-audio-recorder) gives attribution by construction; [transcript-fetcher](../transcript-fetcher) is transcript retrieval on its own; [speaker-timeline-analytics](../speaker-timeline-analytics) uses the platform speaker timeline instead of a model.
