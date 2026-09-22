# Capture Meeting Screenshots on a Timeline with the MeetStream API

Download the screenshots a MeetStream meeting bot captured in a Zoom, Google Meet or Microsoft Teams call from `GET /bots/{bot_id}/get_screenshots`, and generate a report placing each one on the meeting timeline, cross-referenced with the speaker timeline from `GET /bots/{bot_id}/get_speaker_timeline`.

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
git clone https://github.com/meetstream-ai/labs.git
cd labs/screenshot-capture
npm install
cp .env.example .env
node index.js
```

Then set **one** of the two modes in `.env`:

```env
MEETSTREAM_API_KEY=your_api_key_here

# Mode A - a bot that already finished
BOT_ID=bot_abc123

# Mode B - create a new bot and wait for the meeting to end
MEETING_LINK=https://meet.google.com/abc-defg-hij
```

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>` |
| `BOT_ID` | mode A | Fetch screenshots from a bot that already ran |
| `MEETING_LINK` | mode B | Create a new bot for this Zoom, Google Meet or Teams link and wait for the meeting to end |
| `BOT_NAME` | no | Bot display name in mode B (default `MeetStream Screenshot Bot`) |
| `VIDEO_LAYOUT` | no | Layout for the video capture screenshots are cut from: `speaker_view` (default) or `grid_view`. The API default is `grid_view`, so speaker view is sent explicitly |
| `OUTPUT_DIR` | no | Where screenshots and the report go (default `./screenshots-out`) |
| `EVERYONE_LEFT_TIMEOUT` | no | Seconds the bot stays after everyone else left (default `60`) |
| `MEETING_POLL_MAX_ATTEMPTS` | no | Mode B: cap on `GET /bots/{id}/status` polls (default `240`) |
| `MEETING_POLL_INTERVAL_MS` | no | Mode B: delay between status polls (default `15000`) |
| `SCREENSHOT_POLL_MAX_ATTEMPTS` | no | Cap on `get_screenshots` polls while it answers 202/404 (default `30`) |
| `SCREENSHOT_POLL_INTERVAL_MS` | no | Delay between those polls (default `10000`) |
| `REQUEST_TIMEOUT_MS` | no | Per-request timeout (default `30000`) |
| `MAX_RETRIES` | no | Retries for 429/5xx (default `4`); 4xx is never retried |
| `LOG_LEVEL` | no | `silent`, `error`, `warn`, `info` (default) or `debug` |

**Recording defaults.** Screenshots are cut from the video capture, so this template keeps `video_required: true`; it is an exception. Everywhere else in MeetStream Labs video is off by default (`video_required: false`, sent explicitly, because the REST API treats an omitted `video_required` as true). The layout is sent explicitly as `speaker_view` unless you set `VIDEO_LAYOUT=grid_view`, because the API default is `grid_view`. Per-participant video (`video_separate_streams`) is never set here.

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

| Symptom | Cause | Fix |
|---|---|---|
| `Missing required environment variable "MEETSTREAM_API_KEY"` | `.env` missing or empty | `cp .env.example .env` and fill it in |
| `Set either BOT_ID ... or MEETING_LINK` | Neither mode was configured | Set one of the two in `.env` |
| 401 / 403 | 401 = no key sent, 403 = wrong key | Check the key for stray quotes or whitespace |
| 400 on `create_bot` | Bad `MEETING_LINK` | Use the full meeting URL |
| 404 on `get_screenshots` after the meeting | Wrong bot id, nothing captured yet, or the data expired via retention (default 30 days) | Check `GET /bots/{bot_id}/detail`; the loop polls 404 until the cap |
| `get_screenshots` never returns 200 | The bot recorded audio only; screenshots come from video capture | This template already creates the bot with `video_required: true`. If you are fetching screenshots for a `BOT_ID` created elsewhere, that bot must also have had video on |
| Bot ended `NotAllowed` / `Denied` | Never admitted, or the host refused | Nothing was captured; admit the bot from the lobby next time |
| Elapsed column is all `-` | The response had no time field | Look at `raw_get_screenshots_response.json`; if the URLs contain a timestamp in the filename you can sort on that manually |
| Speaker column is missing | The speaker timeline was empty, or the two payloads use different time bases | `timeline.md` states which case applied |
| Some images failed to download | Storage URLs are presigned and expire | Re-run to fetch fresh URLs; the failure is recorded per row in `timeline.json` |

## Related

- [Get bot screenshots](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-screenshots)
- [Get speaker timeline](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-speaker-timeline)
- [Participants and speaker timeline](https://docs.meetstream.ai/guides/features/participants-and-speaker-timeline)
- [Retrieve recordings](https://docs.meetstream.ai/guides/transcription-recordings/retrieve-recordings)
- [Error codes](https://docs.meetstream.ai/errors)
- Related templates: [../speaker-timeline-analytics](../speaker-timeline-analytics), [../video-recording-downloader](../video-recording-downloader)
