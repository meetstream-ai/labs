# recording-archiver

Keeps a local copy of what your MeetStream bots record. Each sweep finds bots whose
post-call processing has finished and downloads:

- the mixed audio file,
- the mixed video file, if the bot recorded video,
- one file per participant, when the bot captured per-participant audio.

It is a plain CLI that polls the API. There is no server and no inbound network
exposure, so there is nothing to deploy and no new public endpoint.

## Setup

```bash
uv venv --python 3.12
uv pip install -e '.[dev]'
cp .env.example .env     # then add your key from https://app.meetstream.ai/api-keys
```

## Use

```bash
recording-archiver                          # one sweep over every bot on the account
recording-archiver --bot-id <BOT_ID>        # just one bot (repeatable)
recording-archiver --watch                  # keep sweeping, every ARCHIVE_POLL_INTERVAL_SECONDS
recording-archiver --dry-run -v             # show what would be downloaded
```

Run it from cron, a launchd job, or `--watch` in a terminal — whatever suits. A sweep
costs one `GET /bots` page plus one `GET /bots/{id}/detail` per unfinished bot; bots
already archived are skipped from the manifest without any API call.

## On disk

```
archive/
  <bot_id>/
    manifest.json
    audio.mp3
    video.mp4                     # only if the bot recorded video
    participants/
      alice-smith-8ae10dfc.webm   # name + short hash of the display name; only if the bot captured per-participant audio
      bob-cd9fb1e1.webm
```

`manifest.json` records the bot's metadata, every file archived with its byte count,
and a `complete` flag. Re-running is safe: finished bots are skipped, missing files are
re-fetched, and downloads are written to a `.part` file and renamed only once complete,
so an interrupted run never leaves a truncated recording behind.

## Per-participant audio is decided at bot creation

The archiver can only download separate speaker tracks if the bot was created with
`audio_separate_streams: true`. You cannot add it after the fact, and it is supported
on **Google Meet and Zoom only — not Microsoft Teams**. For bots without it, the
archiver records `participant_audio: "unavailable"` and moves on.

Likewise, `ARCHIVE_INCLUDE_VIDEO` only controls whether an *existing* video file gets
downloaded. Whether video is recorded at all is `video_required` on `create_bot`, which
defaults to `true` in the API.

## When things are not ready

| Situation | Behaviour |
|---|---|
| Bot still in the meeting, or status `Stopped` | Skipped; no media calls. `Done` is the only status that means processing finished. |
| Media endpoint returns HTTP 202 | Not ready. Bot stays incomplete and is retried next sweep. |
| Media endpoint returns HTTP 404 | Nothing to fetch (never recorded, or retention expired). Settled once, not retried forever. |
| Bot ended `NotAllowed` / `Denied` / `Failed` | Settled once with a note; no recording will ever exist. |
| One bot errors | Logged, sweep continues, exit code 1. |

## Tests

```bash
.venv/bin/python -m pytest
```

85 tests, all HTTP mocked with `responses` — the suite never contacts the real API and
needs no API key.

## Run against the local mock (no API key, no meeting)

[`../mock-meetstream`](../mock-meetstream) is a small offline stand-in for the MeetStream API. It answers with the same request and response shapes, and it plays a short meeting (lifecycle webhooks, live transcript, post-call files) when asked. `mock_e2e.py` starts the mock, runs this app against it, and prints PASS or FAIL.

```bash
python3 -m venv .venv && .venv/bin/pip install -U pip && .venv/bin/pip install -e ".[dev]"
python3 mock_e2e.py
```
