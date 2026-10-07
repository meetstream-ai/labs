# Configure Recording Retention for MeetStream Bots

Create MeetStream API meeting bots for Zoom, Google Meet and Microsoft Teams with an explicit `recording_config.retention` window, or with none so they inherit the API default of 30 days, and understand exactly which recordings and transcripts expire and when.

```bash
npm install
cp .env.example .env   # then fill in MEETSTREAM_API_KEY and MEETING_LINK
node index.js --explain          # semantics only, no API key needed
node index.js --mode timed --hours 72
```

## How it works

1. Builds a `POST /bots/create_bot` body from `.env` and the CLI flags.
2. In `timed` mode adds `recording_config.retention = { type: "timed", hours }`; in `default` mode sends no retention block.
3. `--dry-run` prints the body and stops. Otherwise it creates the bot (201).
4. Reads `GET /bots/{id}/detail` and shows the retention block the API actually stored.

## Prerequisites

- Node.js 18 or newer
- A MeetStream API key from https://app.meetstream.ai
- A Zoom, Google Meet or Microsoft Teams meeting link

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/bot-retention-config
npm install
cp .env.example .env
node index.js --explain
```

## Usage

```bash
node index.js --explain                         # retention semantics, no API call
node index.js --mode timed --hours 72           # keep artifacts for 72 hours
node index.js --mode timed --hours 2            # keep them for 2 hours
node index.js --mode default                    # inherit the API default (720h, 30 days)
node index.js --mode timed --hours 6 --transcript
node index.js --mode timed --hours 6 --dry-run  # print the body, send nothing
```

Start with `--dry-run`. It prints the exact JSON that would be posted, so you can see the shape before you spend a bot on it.

## The two modes

**Timed.** Send the block:

```json
{
  "meeting_link": "https://meet.google.com/xxx-xxxx-xxx",
  "bot_name": "Retention Demo Bot",
  "video_required": false,
  "recording_config": {
    "retention": { "type": "timed", "hours": 72 }
  }
}
```

**Default.** Send no `retention` key at all:

```json
{
  "meeting_link": "https://meet.google.com/xxx-xxxx-xxx",
  "bot_name": "Retention Demo Bot",
  "video_required": false
}
```

There is no `type: "default"`. `"timed"` is the only documented retention type, and "default" means omitting the block, at which point the bot inherits the API default of **720 hours (30 days)**.

Two structural notes people get wrong:

- `retention` is nested under `recording_config`, next to `transcript`. It is not a top-level `create_bot` field.
- Retention is set once, at creation. No endpoint changes the window on an existing bot.

## What actually expires

| Artifact | Endpoint |
|---|---|
| Audio recording | `GET /bots/{id}/get_audio` |
| Video recording | `GET /bots/{id}/get_video` |
| Per-participant audio | `GET /bots/{id}/get_audio_streams` |
| Per-participant video | `GET /bots/{id}/get_recording_streams` |
| Screenshots | `GET /bots/{id}/get_screenshots` |
| Transcript | `GET /transcript/{transcript_id}/get_transcript` |

When the window closes those artifacts are gone the same way they are gone after `DELETE /bots/{id}/delete`. Retention is a delete timer, not a backup policy. Pull down anything you need to keep before it fires.

The clock starts when the session finishes, not when the bot was created, and expiry is asynchronous. Treat the window as "at least N hours", not as a deadline you can schedule against to the minute.

## Choosing a window

**Shorter than default** is the common choice: sensitive calls, or any pipeline that downloads or processes the recording within hours. Thirty days is a long time to leave a second copy on someone else's disk.

**Longer than default** for audit or compliance archives that must outlive a month, or review queues that run on a monthly cycle.

`--transcript` attaches a Deepgram `nova-3` post-call provider so you can watch retention apply to the transcript as well as the media, which is the part teams usually forget.

## Verification

After creating a bot the template reads `GET /bots/{id}/detail`, which echoes back the original request payload, and searches it for the retention block. So you see what the API stored, not just what you sent.

## Retention vs the other two deletion paths

| | Retention expiry | `DELETE /bots/{id}/delete` | `GET /bots/{id}/remove_bot` |
|---|---|---|---|
| Trigger | Time, automatic | You, explicitly | You, explicitly |
| Effect | Artifacts removed | Artifacts removed | Bot leaves the meeting |
| Deletes data | yes | yes | no |
| Reversible | no | no | n/a |

`data_deletion` is the documented webhook for the explicit delete call and for retention expiry. See the [delete-bot-data](../delete-bot-data) template.

## Environment variables

| Name | Required | Default | Meaning |
|---|---|---|---|
| `MEETSTREAM_API_KEY` | yes | | API key, sent as `Authorization: Token <key>`. Not needed for `--explain` or `--dry-run` |
| `MEETING_LINK` | yes | | Full Zoom / Meet / Teams URL |
| `RETENTION_MODE` | no | `timed` | `timed` or `default`, overridden by `--mode` |
| `RETENTION_HOURS` | no | `72` | Overridden by `--hours` |
| `BOT_NAME` | no | `Retention Demo Bot` | Display name in the meeting |
| `VIDEO_REQUIRED` | no | `false` | Video is off by default; `true` records video as well as audio |
| `VIDEO_LAYOUT` | no | `speaker_view` | Only read when `VIDEO_REQUIRED=true`. `speaker_view` or `grid_view`. The API default is `grid_view`, so speaker view is always sent explicitly |
| `MEETSTREAM_API_BASE_URL` | no | `https://api.meetstream.ai/api/v1` | Override for testing |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing required config: MEETSTREAM_API_KEY, MEETING_LINK` | `.env` not filled in | `cp .env.example .env` and set both values. |
| HTTP 401 | No API key was sent | Set `MEETSTREAM_API_KEY`. |
| HTTP 403 | Key rejected | Copy the whole key from the dashboard. |
| HTTP 400 mentioning retention | `hours` not a positive number, `type` not `"timed"`, or block not under `recording_config` | Run `--dry-run` and compare against the JSON above. |
| HTTP 409 | A `deduplication_key` was reused for a different request | Use a new key or the same body. |
| HTTP 429 | Rate limited | Back off and retry. |
| HTTP 507 | Idempotent replay | This is success; the original bot is returned. |
| `detail` shows no retention block after `--mode timed` | Block was not accepted | Re-run with `--dry-run` and check the nesting. |
| Recording vanished earlier than expected | Bot inherited the default window (720 hours) or a shorter workspace setting | Retention is per bot and fixed at creation; set it explicitly. |
| You need an expired recording back | No restore path exists | Download artifacts before the window closes. |

## Related

- [Usage and retention](https://docs.meetstream.ai/guides/features/usage-and-retention)
- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [Create bot payload reference](https://docs.meetstream.ai/api-reference/create-bot-payload-reference)
- [Get bot details](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-details)
- [Delete bot data](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/delete-bot-data)
- [Error codes](https://docs.meetstream.ai/errors)
- Labs: [delete-bot-data](../delete-bot-data), [audio-recording-downloader](../audio-recording-downloader), [video-recording-downloader](../video-recording-downloader)
