# Speaker Timeline Analytics

Turn a MeetStream speaker timeline into conversation metrics - talk-time per
speaker, turn counts, the longest monologue, and overlapping speech - rendered
as an ASCII bar chart in your terminal.

```bash
cp .env.example .env   # add your MEETSTREAM_API_KEY and a BOT_ID or MEETING_LINK
npm install
node index.js
```

## What it does

`GET /bots/{bot_id}/get_speaker_timeline` returns every attributed speech
segment MeetStream captured. This template reads that timeline and computes:

- **Talk-time per speaker**, absolute and as a share of all speech
- **Turn count** - consecutive segments from the same speaker collapse into one turn
- **Average and longest turn** per speaker
- **Longest monologue** in the meeting, and who delivered it
- **Overlapping speech** - turns that began before the previous speaker finished
- **Silence** - recording length minus total speech

Two modes, chosen by your `.env`:

| You set | What happens |
| --- | --- |
| `BOT_ID` | Analyse a meeting a bot already recorded. Nothing is created. |
| `MEETING_LINK` | Create a bot, wait for the meeting to end, then analyse it. |

## Prerequisites

- Node.js 18 or newer (uses the built-in `fetch`)
- A MeetStream API key - <https://app.meetstream.ai>
- A bot that has finished a meeting, or a live meeting link to send one into

## The one thing to understand: bytes, not seconds

The timeline response looks like this:

```json
{
  "chunks": [
    { "chunkIndex": 0, "timestamp": "2026-05-26T10:04:11.220Z", "sampleRate": 48000,
      "speakerId": "spaces/.../devices/290", "speakerName": "Alice",
      "startByte": 0, "endByte": 192000 }
  ],
  "lastUpdated": "2026-05-26T10:41:02.118Z",
  "audioFilePath": "...",
  "totalFileSize": 351436800
}
```

`startByte` and `endByte` are **byte offsets into the recorded audio file, not
time offsets**. Treating them as milliseconds is the single most common way to
get this analysis wrong. To convert:

```
seconds = bytes / (sampleRate × bytesPerSample × channels)
```

`sampleRate` comes from the chunk. MeetStream's audio is 16-bit signed
little-endian mono PCM, so the defaults are `AUDIO_BYTES_PER_SAMPLE=2` and
`AUDIO_CHANNELS=1`; both are overridable in `.env`.

**Percentages are exact regardless.** A talk-time share is a ratio of byte
counts, so the conversion constant cancels out. Only the absolute second
figures depend on the encoding assumption. If no chunk carries a usable
`sampleRate`, the template says so and reports shares and byte counts only,
rather than inventing durations.

## How turns and overlaps are defined

- A **turn** is a run of consecutive chunks (ordered by `chunkIndex`) with the
  same `speakerId`. One person speaking across ten chunks is one turn, not ten.
- An **overlap** is an adjacent pair of turns from *different* speakers whose
  byte ranges intersect - the second speaker started before the first one's
  audio ended. That is the closest honest proxy for an interruption the
  timeline supports; it does not attempt to judge intent.

## How it works

```
index.js               entry point, polling, file output
src/client.js          MeetStream HTTP client (Token auth, 202/507 handling, retries)
src/session.js         resolve BOT_ID, or create a bot and wait for it to finish
src/analytics.js       timeline -> metrics (all the maths, no formatting)
src/report.js          metrics -> terminal report with bar chart
src/format.js          duration / percent / bar / table helpers
```

`src/analytics.js` is pure and has no I/O, so it is the piece to lift into your
own service.

## Output

Console:

```
Talk-time share
===============

Alice                    ████████████████████·········· 63.4%  18m 41s
Bob                      █████████·····················  29.1%  8m 34s
Carol                    ██····························   7.5%  2m 12s

Per speaker
===========

Speaker  Talk time  Share  Turns  Avg turn  Longest turn  Talked over
-------  ---------  -----  -----  --------  ------------  -----------
Alice      18m 41s  63.4%     41     27.3s       3m 12s             6
...
```

Files:

- `output/speaker-timeline-<bot_id>.json` - the untouched API response
- `output/speaker-analytics-<bot_id>.json` - the computed metrics, including
  the encoding assumptions used

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `MEETSTREAM_API_KEY is not set` | `cp .env.example .env` and paste your key. |
| HTTP 401 / 403 | No key sent, or the key is inactive for this workspace. |
| HTTP 404 | Wrong bot id, or the data expired via its retention window. |
| Still 202 after the poll cap | Audio processing has not finished. Re-run later with `BOT_ID`, or raise `TIMELINE_POLL_MAX_ATTEMPTS`. |
| "The speaker timeline is empty" | The bot never joined, nobody spoke, or processing is still running. Check `GET /bots/{id}/status`. |
| Durations look wrong, shares look right | The encoding assumption is off for your account. Adjust `AUDIO_BYTES_PER_SAMPLE` / `AUDIO_CHANNELS`. |
| "absolute durations cannot be computed" | No chunk carried a positive `sampleRate`. Byte-based shares are still valid. |
| All speech attributed to "Unknown speaker" | The chunks carry no `speakerName`. Enable diarization on the transcript provider. |

## Resources

- [MeetStream docs](https://docs.meetstream.ai)
- [API reference](https://docs.meetstream.ai/api-reference)
