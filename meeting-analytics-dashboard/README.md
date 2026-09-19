# Build a Meeting Analytics Report with the MeetStream API

Everything the MeetStream API knows about one Zoom, Google Meet or Microsoft Teams meeting, consolidated into a single report: participants, talk-time per speaker, in-meeting chat, the AI summary and the bot lifecycle, printed to your terminal and written as JSON and Markdown.

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
- A MeetStream API key from <https://app.meetstream.ai>
- A bot that has finished a meeting, or a live Zoom, Google Meet or Teams link to send one into

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/meeting-analytics-dashboard
npm install
cp .env.example .env   # add MEETSTREAM_API_KEY and a BOT_ID or MEETING_LINK
node index.js
```

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>`. |
| `BOT_ID` | one of | Existing bot to report on. Takes priority over `MEETING_LINK`. |
| `MEETING_LINK` | one of | Zoom, Google Meet or Teams link. A new bot is created for it. |
| `BOT_NAME` | no | Display name in the meeting. Default `MeetStream Analytics Bot`. |
| `TRANSCRIPT_LANGUAGE` | no | Language passed to the Deepgram post-call provider. Default `en`. |
| `RETENTION_HOURS` | no | `recording_config.retention.hours` on create. Default `72`. |
| `WAITING_ROOM_TIMEOUT` | no | `automatic_leave.waiting_room_timeout` seconds. Default `600`. |
| `EVERYONE_LEFT_TIMEOUT` | no | `automatic_leave.everyone_left_timeout` seconds. Default `600`. |
| `IN_CALL_RECORDING_TIMEOUT` | no | `automatic_leave.in_call_recording_timeout` seconds. Default `14400`, API minimum 600. |
| `IDEMPOTENCY_KEY` | no | `Idempotency-Key` header on `create_bot`. A replay returns HTTP 507 and is treated as success. |
| `STATUS_POLL_INTERVAL_MS` | no | Delay between status polls while waiting for the meeting to end. Default `15000`. |
| `STATUS_POLL_MAX_ATTEMPTS` | no | Status poll cap. Default `240`. |
| `SECTION_POLL_INTERVAL_MS` | no | Delay between polls while a source answers 202. Default `10000`. |
| `SECTION_POLL_MAX_ATTEMPTS` | no | Per-source 202 poll cap. Default `12`. |
| `AUDIO_BYTES_PER_SAMPLE` | no | Used to turn speaker-timeline byte offsets into seconds. Default `2`. |
| `AUDIO_CHANNELS` | no | Same conversion. Default `1`. |
| `BAR_WIDTH` | no | Width of the talk-time bars. Default `30`. |
| `OUTPUT_DIR` | no | Where the JSON and Markdown reports are written. Default `./output`. |
| `INCLUDE_RAW_RESPONSES` | no | `false` drops the raw API responses from the JSON report. Default `true`. |
| `REQUEST_TIMEOUT_MS` | no | Per-request timeout. Default `30000`. |
| `MAX_RETRIES` | no | Retries on network errors and 429/5xx. Default `3`. |
| `RETRY_BASE_DELAY_MS` | no | Backoff base. Default `1000`. |
| `MEETSTREAM_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |

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

| Symptom | Cause | Fix |
| --- | --- | --- |
| `MEETSTREAM_API_KEY is not set` | No `.env` or empty key. | `cp .env.example .env` and paste your key. |
| HTTP 401 / 403 | No key sent, or the key is inactive for this workspace. | Check `.env` is loaded from this directory; regenerate the key at <https://app.meetstream.ai>. |
| HTTP 400 on create | `in_call_recording_timeout` below its 600 second minimum, or a missing `meeting_link` / `bot_name`. | Fix the value in `.env`. |
| `No bot found with id ...` (404) | Wrong bot id, or the data expired via its retention window. | Confirm the id with `GET /bots`. |
| HTTP 507 on create | Idempotent replay of an earlier `create_bot` with the same `Idempotency-Key`. | Nothing to fix; the original bot is returned. |
| Summary shows "not available" | The bot used a streaming-only provider, or no summary workflow is enabled. | Use a post-call provider such as `deepgram`. |
| A section shows "still processing" | Post-call processing has not finished (HTTP 202). | Re-run later with `BOT_ID`, or raise `SECTION_POLL_MAX_ATTEMPTS`. |
| Bot status ends at `NotAllowed` / `Denied` | The bot timed out in the waiting room, or the host refused it. | Admit it faster, or raise `WAITING_ROOM_TIMEOUT`. |
| Talk-time durations look wrong | The audio is not 16-bit mono PCM. | Adjust `AUDIO_BYTES_PER_SAMPLE` / `AUDIO_CHANNELS`. Shares stay correct either way. |
| Chat authors all "Unknown" | Your account's key names are not in `src/normalize.js`. | Check `chat.unmapped_fields` in the JSON report and add them. |
| Report is mostly empty | The bot probably never got into the meeting. | Check the lifecycle section and `GET /bots/{id}/status`. |

## Related

- [Get bot details](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-details)
- [Fetch participants](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/fetch-participants)
- [Get speaker timeline](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-speaker-timeline)
- [Get bot chats](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-chats)
- [Get bot summary](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-summary)
- [Participants and speaker timeline guide](https://docs.meetstream.ai/guides/features/participants-and-speaker-timeline)
- [Error reference](https://docs.meetstream.ai/errors)
- Templates: [speaker-timeline-analytics](../speaker-timeline-analytics/README.md), [participant-tracker](../participant-tracker/README.md), [ai-meeting-summary](../ai-meeting-summary/README.md), [meeting-chat-logger](../meeting-chat-logger/README.md)
