# bulk-bot-operations

The "we need 50 bots today" template: a concurrency-limited queue, a deterministic per-job `Idempotency-Key` so retries and re-runs never duplicate a bot, live progress, and an aggregated report you can feed back in.

```bash
npm install && node index.js --simulate
```

`--simulate` runs 10 jobs against a fake API. No key, no cost, no real bots.

---

## What this does

```bash
node index.js --simulate                    # 10 example jobs, fake API, no key needed
node index.js --dry-run --file jobs.json    # validate and print payloads, call nothing
node index.js --file jobs.json              # real run
node index.js --file jobs.json --batch-id nightly-2026-08-23 --concurrency 8
```

Output:

```
  [ 1/10] acme-standup         CREATED bot_id=bot_bfa1ab7ee8e4
  [ 2/10] acme-qbr             CREATED bot_id=bot_0361b4fceed4

  RETRY hooli-allhands: attempt 1/4 in 102ms after 503: Service temporarily unavailable.

  [10/10] soylent-duplicate-of-allhands FAILED  409: A bot has already been created for this meeting link.

  Batch demo-batch summary
             submitted: 10
             created: 9
             replayed (507, already existed): 0
             failed: 1

  Failures, grouped by reason:
    1x  409 A bot has already been created for this meeting link.
         jobs: soylent-duplicate-of-allhands
```

Run the exact same command again and every finished job comes back as a replay, with the same `bot_id`:

```
  created: 0
  replayed (507, already existed): 9
  failed: 1
```

That is the whole point.

## Prerequisites

- Node.js 18 or newer
- A MeetStream API key for real runs: https://app.meetstream.ai
- Optionally a public HTTPS `CALLBACK_URL` if you want webhooks. See the `webhook-local-tunnel` template.

## Setup

```bash
cp .env.example .env
cp jobs.example.json jobs.json   # then edit
npm install
```

---

## Idempotency: the part that matters

At one bot, a duplicate is annoying. At fifty, it is a bill.

Every job gets a key derived from the batch id, the job id, and the payload:

```js
idempotencyKeyFor(batchId, job, payload)
  = sha256(`${batchId}|${job.id}|${JSON.stringify(payload)}`).slice(0, 40)
```

Three consequences:

1. **A retry cannot duplicate.** The retry wrapper reuses the same key across every attempt of a job, so an attempt the server already processed comes back as `507` rather than a second bot. This is what makes retrying a `POST` safe at all.
2. **A re-run of the batch replays.** If a batch of 50 dies at job 37, re-run the same file with the same `--batch-id`. The first 36 return `507` with their original `bot_id`, and only the rest are actually created. No bookkeeping needed on your side.
3. **An edited job is genuinely re-created.** The payload is folded into the hash, so changing a job's meeting link or provider yields a new key. Identical input replays, changed input does not.

`--batch-id` defaults to a timestamp, which means every run is treated as a **new** batch. Pass a stable id whenever you might re-run.

The client refuses to call `createBot` without a key:

```
createBot requires an idempotencyKey. Derive it from the job id so
re-runs replay instead of duplicating.
```

`507` is a **success**, not an error. It resolves as `{ status: 507, replay: true, data }` and is counted separately in the report.

## Concurrency

`src/queue.js` runs at most `concurrency` jobs at once.

Why not `Promise.all(jobs.map(run))`:

- Fifty simultaneous `create_bot` calls get you rate limited, and then all fifty back off and retry in lockstep.
- One rejection in `Promise.all` throws away every other job's result. In bulk work you want every outcome, including the failures.

The queue never throws for a single job. Each job settles into `{ ok, value | error, durationMs }` and the batch always completes.

`STAGGER_MS` adds a small delay between job **starts**, so the first `CONCURRENCY` workers do not all fire in the same millisecond. Start at `CONCURRENCY=5` and raise it while watching for 429s. Requests already retry with backoff and honor `Retry-After`, but the cheapest way to survive a rate limit is not to trip it.

## Validate before you submit

A batch of 50 that dies on job 37 with `meeting_link is required.` is 36 bots you did not mean to create. `src/jobs.js` validates everything locally first:

- `meeting_link` present and URL-shaped (and it is `meeting_link`, **not** `meeting_url`, which is a response field)
- job ids unique, since they seed the `Idempotency-Key`
- provider is a real one
- `callback_url` is `https`
- `automatic_leave.in_call_recording_timeout` is at least **600** (a hard API floor)
- `automatic_leave.recording_permission_denied_timeout` is 60 to 300 (Zoom only)
- every `custom_attributes` value is a **string**

Rejected jobs are listed and never submitted. `--dry-run` prints the exact payload and key for each job and calls nothing.

## The jobs file

A JSON array, `{ "jobs": [...] }`, or one JSON object per line. See `jobs.example.json`.

```json
{
  "id": "acme-qbr",
  "meeting_link": "https://us02web.zoom.us/j/1234567890",
  "bot_name": "Acme QBR Recorder",
  "video_required": true,
  "provider": "deepgram",
  "join_at": "2026-12-01T15:00:00Z",
  "callback_url": "https://you.example.com/webhook",
  "automatic_leave": { "waiting_room_timeout": 300, "in_call_recording_timeout": 3600 },
  "custom_attributes": { "account_id": "acct_1001" }
}
```

Anything a job omits falls back to the `DEFAULT_*` values in `.env`.

Two attributes are stamped onto every bot automatically:

- `batch_id` so you can find every bot from a run later
- `streaming_only` (`"true"` / `"false"`) because webhooks never carry the transcription provider, and the provider decides whether the event stream ends at `bot.done` or at `audio.processed`

## The report

Written to `output/batch-<id>.json`:

```json
{
  "batchId": "nightly-2026-08-23",
  "totals": { "submitted": 50, "created": 47, "replayed": 2, "failed": 1, "rejectedBeforeSubmit": 0 },
  "created": [{ "jobId": "...", "botId": "...", "transcriptId": "...", "streamingOnly": false }],
  "replayed": [{ "jobId": "...", "botId": "..." }],
  "failed": [{ "jobId": "...", "status": 409, "message": "...", "retryable": false }],
  "failuresByReason": { "429 Request was throttled.": ["job-7", "job-12"] },
  "retryJobIds": ["job-7", "job-12"]
}
```

Failures are grouped by reason, so thirty identical 429s read as one line rather than thirty. `retryJobIds` lists only the failures worth retrying: a 409 or a 400 will fail identically forever and is excluded.

`transcript_id` is `null` for `meeting_captions` and for streaming-only runs. That is expected, not a bug.

The process exits `1` when anything failed, so CI notices.

## How it works

```
index.js             CLI: load, validate, run, report. --simulate / --dry-run
src/jobs.js          loadJobs, validateJobs, toCreateBotPayload, idempotencyKeyFor
src/queue.js         bounded-concurrency queue, per-job settlement, never throws
src/client.js        Token auth, caller-supplied Idempotency-Key, 507-as-success, timeouts
src/retry.js         withRetry: retryable-only, Retry-After, full jitter, wall-clock budget
src/errors.js        MeetStreamError + the status decision table
src/report.js        aggregate, printSummary, writeReport
src/progress.js      TTY progress bar, plain lines in CI
src/simulate.js      deterministic fake API (201 / 507 / 409 / 503), state persisted
```

`src/simulate.js` persists its key store to `output/.simulated-api-state.json`, so a second `--simulate` run with the same batch id really does return 507. It is not pretending.

## Troubleshooting

**Duplicate bots after a re-run.** Your `--batch-id` changed. Without one it defaults to a timestamp, which makes every run a new batch. Pass a stable id.

**Lots of 429s.** Lower `CONCURRENCY`, raise `STAGGER_MS`. The retry wrapper honors `Retry-After`, but staying under the limit is cheaper than recovering from it.

**Everything fails with 401.** The header is `Authorization: Token <key>`. `Bearer` is rejected.

**A job fails with 409.** A bot already exists for that meeting link. Two jobs in `jobs.example.json` deliberately collide to demonstrate this. Find the existing bot with `GET /bots` and reuse its `bot_id` instead of creating another.

**`in_call_recording_timeout must be at least 600 seconds.`** Real floor. Validation catches it locally before the batch starts.

**No webhooks from any of the bots.** `CALLBACK_URL` is per bot on `create_bot`. There is no account-wide webhook setting, and the URL must be public HTTPS.

**`created: 0, replayed: N` and you expected new bots.** You re-ran an unchanged file with the same batch id. That is the safety net working. Change the batch id to create genuinely new bots.

## Resources

- MeetStream Docs: https://docs.meetstream.ai
- API Reference: https://docs.meetstream.ai/api-reference
