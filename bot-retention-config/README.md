# bot-retention-config

Create MeetStream bots with an explicit `recording_config.retention` window, or with none so they inherit the API default, and understand exactly what expires and when.

```bash
npm install
cp .env.example .env   # then fill in MEETSTREAM_API_KEY and MEETING_LINK
node index.js --explain          # semantics only, no API key needed
node index.js --mode timed --hours 72
```

## Prerequisites

- Node.js 18 or newer
- A MeetStream API key from https://app.meetstream.ai
- A meeting link

## Usage

```bash
node index.js --explain                         # retention semantics, no API call
node index.js --mode timed --hours 72           # keep artifacts for 72 hours
node index.js --mode timed --hours 2            # keep them for 2 hours
node index.js --mode default                    # inherit the API default (24h)
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

There is no `type: "default"`. `"timed"` is the only documented retention type, and "default" means omitting the block, at which point the bot inherits the API default of **24 hours**.

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

**Shorter than default** for sensitive calls, or when your pipeline downloads the recording within minutes and you would rather not leave a second copy on someone else's disk.

**Longer than default** for human review queues and weekly QA sampling, anywhere a person may not open the call until days later. A 24-hour default plus a Monday morning review process means the recording is gone before anybody looks at it.

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

`data_deletion` is the documented webhook for the explicit delete call. See the `delete-bot-data` template.

## Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MEETSTREAM_API_KEY` | yes | | Not needed for `--explain` or `--dry-run` |
| `MEETING_LINK` | yes | | Full Zoom / Meet / Teams URL |
| `RETENTION_MODE` | no | `timed` | `timed` or `default`, overridden by `--mode` |
| `RETENTION_HOURS` | no | `72` | Overridden by `--hours` |
| `BOT_NAME` | no | `Retention Demo Bot` | |
| `VIDEO_REQUIRED` | no | `false` | `true` records video too |
| `MEETSTREAM_API_BASE_URL` | no | production | Override for testing |

## Troubleshooting

**`API error 400` mentioning retention** - `hours` must be a positive number, and `type` must be `"timed"`. Check the block is nested under `recording_config`.

**detail shows no retention block after `--mode timed`** - the block was not accepted. Re-run with `--dry-run` and compare the JSON against the shape above.

**A recording vanished earlier than expected** - the bot was created without a retention block and inherited the 24-hour default. Retention is per bot and is fixed at creation.

**You need it back** - you cannot get it back. There is no restore path for expired or deleted artifacts.
