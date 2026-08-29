# screenshot-capture

Download a meeting's screenshots from `GET /bots/{bot_id}/get_screenshots` and generate a report placing each one on the meeting timeline, cross-referenced with the speaker timeline.

```bash
npm install && node index.js
```

## What it does

1. Fetches screenshots for a bot (either one you already ran, or a fresh one it creates).
2. Downloads every image into `screenshots/`.
3. Fetches `GET /bots/{bot_id}/get_speaker_timeline`.
4. Writes `timeline.md` (human) and `timeline.json` (machine) mapping each screenshot to its elapsed time and, where possible, who was speaking.

```
screenshots-out/
  2026-08-23_10-14-02_bot_abc123/
    screenshots/
      shot_001.png
      shot_002.png
      shot_003.png
    timeline.md
    timeline.json
    raw_get_screenshots_response.json
    raw_get_speaker_timeline_response.json
```

`timeline.md` looks like:

```markdown
| # | Elapsed | Speaking | File |
|---|---------|----------|------|
| 1 | 0:00:00 | Alice Chen | screenshots/shot_001.png |
| 2 | 0:02:30 | Bob Patel  | screenshots/shot_002.png |
| 3 | 0:05:00 | -          | screenshots/shot_003.png |
```

## Prerequisites

- Node.js 18 or newer (uses built-in `fetch`)
- A MeetStream API key: https://app.meetstream.ai
- A bot that recorded video - screenshots come from the video capture, so an audio-only bot has none

No public URL or tunnel is needed: this template is poll-only and never receives webhooks.

## Setup

```bash
npm install
cp .env.example .env
```

Then set **one** of the two modes in `.env`:

```env
MEETSTREAM_API_KEY=your_api_key_here

# Mode A - a bot that already finished
BOT_ID=bot_abc123

# Mode B - create a new bot and wait for the meeting to end
MEETING_LINK=https://meet.google.com/abc-defg-hij
```

## Run

```bash
node index.js
```

In mode B, press `Ctrl+C` to pull the bot out of the meeting and jump straight to collecting screenshots. A second `Ctrl+C` quits immediately.

## How it works

### Timeline mapping

Screenshots are only useful if you know *when* they were taken. The template:

1. Walks the `get_screenshots` body for image URLs and, for each one, looks for a time value on the object it was found on (`timestamp`, `captured_at`, `created_at`, `offset`, and similar).
2. Normalises whatever it finds - ISO 8601 strings, epoch seconds, epoch milliseconds, `HH:MM:SS` clock offsets - into milliseconds, while recording whether the value was **absolute** (a real instant) or **relative** (an offset from the start of the meeting).
3. Uses the earliest screenshot as t0 and reports every other shot as elapsed time from there.
4. Normalises the speaker timeline the same way and, for each screenshot, reports the speaker whose turn covers that instant.

**It refuses to guess.** If no recognisable time field is present, the report says so and lists shots in response order instead of inventing timestamps. If the screenshots and the speaker timeline use different time bases (one absolute, one relative), the speaker column is omitted with an explanation - correlating them would produce plausible-looking nonsense. Both raw API bodies are always saved so you can check the real values.

### Status codes

| Status | Meaning | Behaviour |
|---|---|---|
| 200 | Screenshots ready | Download |
| 202 | Still processing | Poll again, up to `SCREENSHOT_POLL_MAX_ATTEMPTS` |
| 404 | Nothing captured yet | Poll again |
| 429, 5xx | Transient | Retry with exponential backoff |
| **507** | **Idempotent replay** | **Treated as success** |

Auth is `Authorization: Token <key>` - literally `Token`, not `Bearer`. Error bodies are `{ "message": "..." }` and that message is surfaced on every failure.

## What screenshots are good for

- Visual QA that the bot actually saw the meeting (and not a permissions dialog)
- Recovering slides from a screen share without processing the full video
- Thumbnails for a recording library
- Anchoring a transcript summary to what was on screen at that moment

## Troubleshooting

**`get_screenshots` never returns 200** - the most common cause is a bot that recorded audio only. Screenshots come from video capture. Confirm with `GET /bots/{bot_id}/detail`.

**Elapsed column is all `-`** - the response had no time field. Look at `raw_get_screenshots_response.json`; if the URLs contain a timestamp in the filename you can sort on that manually.

**Speaker column is missing** - either the speaker timeline was empty, or the two payloads use different time bases. `timeline.md` states which case applied.

**Some images failed to download** - storage URLs are presigned and expire. Re-run to fetch fresh URLs; the failure is recorded per row in `timeline.json`.

**`Set either BOT_ID ... or MEETING_LINK`** - neither mode was configured in `.env`.

## Reference

- [MeetStream docs](https://docs.meetstream.ai)
- [API reference](https://docs.meetstream.ai/api-reference)
