# Meeting Analytics Dashboard

Everything MeetStream knows about one meeting, consolidated into a single
report - printed to your terminal and written as JSON and Markdown.

```bash
cp .env.example .env   # add your MEETSTREAM_API_KEY and a BOT_ID or MEETING_LINK
npm install
node index.js
```

## What it does

Reads five endpoints for one bot and merges them into one document:

| Endpoint | Contributes |
| --- | --- |
| `GET /bots/{id}/detail` | Meeting link, platform, start/end, final status, transcript id, lifecycle timeline |
| `GET /bots/{id}/get_participants` | Roster, per-participant stream counts, screen shares |
| `GET /bots/{id}/get_speaker_timeline` | Talk-time per speaker, turns, longest monologue, overlapping speech |
| `GET /bots/{id}/get_chats` | In-meeting chat, per-author counts, full transcript |
| `GET /bots/{id}/summary` | MeetStream's native AI summary |

Two modes, chosen by your `.env`:

| You set | What happens |
| --- | --- |
| `BOT_ID` | Report on a meeting a bot already recorded. Nothing is created. |
| `MEETING_LINK` | Create a bot, wait for the meeting to end, then report. |

## Prerequisites

- Node.js 18 or newer (uses the built-in `fetch`)
- A MeetStream API key - <https://app.meetstream.ai>
- A bot that has finished a meeting, or a live meeting link to send one into

## Partial data is normal

Any one of the five sources can legitimately be unavailable:

- a bot created with a **streaming-only** transcript provider
  (`deepgram_streaming`, `assemblyai_streaming`, `meetstream_streaming`,
  `jigsawstack_streaming`, `meeting_captions`) never produces a post-call
  transcript, so there is nothing to summarise
- a meeting where nobody typed has no chat
- a bot that was denied entry has no speaker timeline
- anything still processing answers **HTTP 202**

So each source is fetched independently and records its own outcome. One
missing piece degrades that section, it does not fail the run. The report
always opens with a data-sources table telling you exactly what was and was
not available, and why:

```
Data sources
============

Endpoint          Result           Note
----------------  ---------------  -----------------------------------
Detail            ok
Participants      ok
Speaker Timeline  ok
Chats             ok
Summary           not available    No summary for this bot. Summaries…
```

Only a 404 on `detail` is fatal - that means the bot id does not exist or its
data has already expired.

## How it works

```
index.js               entry point, output files, exit reporting
src/client.js          MeetStream HTTP client (Token auth, 202/507 handling, retries)
src/session.js         resolve BOT_ID, or create a bot and wait for it to finish
src/collect.js         fetch all five sources, each with its own status
src/analytics.js       speaker timeline -> talk-time / turn / overlap metrics
src/normalize.js       chat response -> normalised messages
src/dashboard.js       build the report object, terminal view, Markdown view
src/format.js          duration / percent / bar / table helpers
```

Sources are fetched **sequentially, not in parallel** - five simultaneous poll
loops against one bot is a reliable way to get rate limited for no benefit.

### Two details worth knowing

**Talk time comes from byte offsets, not timestamps.** The speaker timeline's
`startByte` / `endByte` are offsets into the recorded audio file. Seconds are
derived as `bytes / (sampleRate × bytesPerSample × channels)` using 16-bit mono
PCM defaults (`AUDIO_BYTES_PER_SAMPLE`, `AUDIO_CHANNELS`). Percentage shares
are exact regardless, since they are byte ratios.

**The chat schema varies by platform**, so `src/normalize.js` detects the
author / text / timestamp field names rather than assuming them, and records
the mapping it used in the JSON report under `chat.field_mapping`.

## Output

Console: an overview table, the data-sources table, the AI summary, an ASCII
talk-time chart, per-speaker metrics, the participant roster, chat counts and
the lifecycle stages the bot reached.

```
Talk-time share
===============

Alice                    ████████████████████·········· 63.4%  18m 41s
Bob                      █████████·····················  29.1%   8m 34s
Carol                    ██····························   7.5%   2m 12s
```

Files:

- `output/meeting-report-<bot_id>.json` - the full structured report,
  including every raw API response (set `INCLUDE_RAW_RESPONSES=false` to drop
  them for a smaller file)
- `output/meeting-report-<bot_id>.md` - the same report as a shareable document

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `MEETSTREAM_API_KEY is not set` | `cp .env.example .env` and paste your key. |
| HTTP 401 / 403 | No key sent, or the key is inactive for this workspace. |
| `No bot found with id …` | Wrong bot id, or the data expired via its retention window. |
| Summary shows "not available" | The bot used a streaming-only provider, or no summary workflow is enabled. |
| A section shows "still processing" | Post-call processing has not finished. Re-run later with `BOT_ID`, or raise `SECTION_POLL_MAX_ATTEMPTS`. |
| Talk-time durations look wrong | Adjust `AUDIO_BYTES_PER_SAMPLE` / `AUDIO_CHANNELS`. Shares stay correct either way. |
| Chat authors all "Unknown" | Your account's key names are not in `src/normalize.js`. Check `chat.unmapped_fields` in the JSON report and add them. |
| Report is mostly empty | The bot probably never got into the meeting. Check the lifecycle section and `GET /bots/{id}/status`. |

## Resources

- [MeetStream docs](https://docs.meetstream.ai)
- [API reference](https://docs.meetstream.ai/api-reference)
