# dispatch-bots

Send a MeetStream bot to every meeting link in a list - Zoom, Google Meet and
Teams mixed in the same file - and print a summary of which bots went out and
which did not, with the reason.

## Install

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

## Configure

```bash
cp .env.example .env     # then fill in MEETSTREAM_API_KEY
```

Every setting is documented in `.env.example`. Real environment variables win
over the file, so CI can set `MEETSTREAM_API_KEY` without one. `.env` is
gitignored; do not commit a key.

## Use

```bash
.venv/bin/dispatch-bots links.txt                 # send the bots
.venv/bin/dispatch-bots links.txt --dry-run       # validate only, no API calls
.venv/bin/dispatch-bots links.txt --json          # machine-readable summary
cat links.txt | .venv/bin/dispatch-bots -         # read links from stdin
```

Input format (see `links.example.txt`): one meeting URL per line, optionally
followed by `,<bot name>` to override the default bot name for that meeting.
Blank lines and `#` comments are ignored.

Useful flags: `--bot-name`, `--callback-url`, `--concurrency`, `--max-retries`,
`--allow-duplicates`, `--env-file`, `-v`.

## What it does with bad links and rate limits

**Bad links** are caught before any API call, so a typo costs nothing. Each one
is reported with a specific reason: not https, not a recognised meeting link, a
Google Meet `lookup/` link, a Zoom
personal-room link, or a duplicate of an earlier line. Duplicates are skipped by
default so two bots never join the same meeting (`--allow-duplicates` to
override).

**Rate limits (HTTP 429)** are retried honouring the `Retry-After` header, in
either seconds or HTTP-date form, capped at `MEETSTREAM_MAX_BACKOFF`. When one
worker is rate limited, every other worker pauses with it, instead of all of
them burning their retry budget on 429s. Without a `Retry-After`, retries use
exponential backoff with jitter.

**Transient failures** (408, 5xx, 507 capacity, connection errors and timeouts)
are retried the same way. **Permanent failures** (400, 401, 403, 404, 409, 422)
are not retried - they are reported immediately with the API's own message.

## Summary and exit codes

The run ends with the dispatched bots and their `bot_id`s, then the failures and
skips with their reasons and attempt counts.

| Exit code | Meaning |
|---|---|
| 0 | every link produced a bot |
| 1 | at least one link failed or was skipped |
| 2 | usage or config error (nothing was dispatched) |

## Cost

Bots are created audio-only (`video_required: false`), which is cheaper to
process and store; transcripts, summaries and diarization do not need video.
Set `MEETSTREAM_RETENTION_HOURS` to the shortest window you can live with -
the account default is 720 hours. Concurrency is bounded (default 4) and
pre-flight validation keeps bad links from becoming API calls.

Post-call transcription is off by default; set `MEETSTREAM_TRANSCRIPT_PROVIDER`
to `meetstream` or `deepgram` to turn it on (`deepgram` needs a Deepgram key on
your MeetStream account).

## Tests

```bash
.venv/bin/python -m pytest
```

The suite never touches the network: the HTTP session, the clock and `sleep`
are injected, so retry and rate-limit behaviour is tested exactly and instantly.

## Changed after generation

The generated link check rejected `teams.live.com` links and the newer `teams.microsoft.com/meet/<id>` form. The MeetStream API accepts both, so the check now accepts them too (`src/dispatcher/links.py`, with tests).

## Run against the local mock (no API key, no meeting)

[`../mock-meetstream`](../mock-meetstream) is a small offline stand-in for the MeetStream API. It answers with the same request and response shapes, and it plays a short meeting (lifecycle webhooks, live transcript, post-call files) when asked. `mock_e2e.py` starts the mock, runs this app against it, and prints PASS or FAIL.

```bash
python3 -m venv .venv && .venv/bin/pip install -U pip && .venv/bin/pip install -e ".[dev]"
python3 mock_e2e.py
```
