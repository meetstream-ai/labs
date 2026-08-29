# error-handling-and-retries

A production-grade MeetStream API client that walks the entire error surface: 400, 401 vs 403, 404, 409, 429 with `Retry-After`, 500/503 backoff, **507 treated as success**, and **202 polling with a hard cap**.

```bash
npm install && node index.js
```

No API key needed for the default run. Every case is exercised against a deterministic mock transport, so it is free and repeatable.

---

## What this does

```bash
node index.js          # offline matrix: 11 scenarios, no network, no cost
node index.js --live   # plus real-API probes for 401 / 403 / 400 / 404
node index.js --table  # print the status decision table and exit
```

Sample output:

```
>> 507 - idempotent replay is a SUCCESS
             status: 507
             replay: true
             Idempotency-Key sent: fixed-key-for-this-job
             bot_id returned: bot_abc123
OK   The original request already created bot_abc123. Treating 507 as an
     error would double-create on retry or fake an outage.

>> 202 forever - streaming-only bot, capped instead of hanging
             attempts: 4
             gave up after: 356ms
OK   Streaming-only providers never produce a post-call transcript, so 202
     is the permanent answer. An uncapped poll here hangs the worker forever.
```

The `--live` probes only trigger validation and auth failures. They create nothing and cost nothing.

## Prerequisites

- Node.js 18 or newer
- A MeetStream API key, only for two of the `--live` probes: https://app.meetstream.ai

## Setup

```bash
cp .env.example .env   # optional, only needed for --live
npm install
```

---

## The decision table

Every status the API returns, and what your client should do about it.

| Code | Category | Retry? | What to do |
| --- | --- | --- | --- |
| 200 / 201 | success | no | Done. |
| **202** | pending | no | **Not an error.** Still processing. Poll again, with a cap. |
| 400 | validation | no | Your body is wrong. The `message` names the field. |
| 401 | auth | no | No key was sent. Check the header exists and says `Token`, not `Bearer`. |
| 403 | auth | no | A key was sent but it is not valid. |
| 404 | not_found | no | No such resource. |
| 409 | conflict | no | A matching bot already exists. Reuse it. |
| 429 | rate_limit | **yes** | Honor `Retry-After`, else exponential backoff. |
| 500 / 502 / 503 / 504 | server | **yes** | Exponential backoff with jitter. |
| **507** | idempotent_replay | no | **Success.** You replayed an `Idempotency-Key`. |

Error bodies are always `{ "message": "..." }`. Surface that message. It is the most useful thing in a failed request.

### 401 vs 403

They are not interchangeable.

- **401** = no `Authorization` header reached the API. Your env var is empty, or you wrote `Bearer ${key}`. The header is literally `Token ${key}`.
- **403** = a header arrived, but the key is not valid: revoked, typo'd, or from the wrong environment.

Chasing a 403 by re-checking your env plumbing wastes an afternoon. Chasing a 401 by regenerating your key wastes another.

### 507 is a success

`507` means "I already processed this exact `Idempotency-Key`". The original request succeeded and the response body carries the original result.

```js
const res = await api.createBot(payload, { idempotencyKey: jobId });
// res.status === 507, res.replay === true, res.data.bot_id === the ORIGINAL bot
```

Two ways teams get this wrong:

1. Treating `507` as a failure and retrying without the key, which creates a second bot for the same meeting and bills you twice.
2. Treating `507` as a failure and paging someone, turning a working retry into a fake outage.

`src/client.js` resolves it as `{ status: 507, replay: true, data }`. It never throws.

### 202 needs a cap

`GET /transcript/{transcript_id}/get_transcript` answers `202` while the transcript is still being produced.

For a post-call provider (`deepgram`, `assemblyai`, `sarvam`, `jigsawstack`, `meetstream`) that resolves within minutes. For a **streaming-only** provider (`deepgram_streaming`, `assemblyai_streaming`, `jigsawstack_streaming`, `meetstream_streaming`, `meeting_captions`) there is no post-call transcript at all, so `202` is the permanent answer. An uncapped poll on one of those bots hangs the worker forever.

`src/poll.js` caps by attempt count **and** by wall clock, then throws a `PollTimeoutError` whose message names the streaming-only case as the likely cause.

```js
import { pollUntilReady } from './src/poll.js';

const result = await pollUntilReady(() => api.getTranscript(transcriptId), {
  maxAttempts: 30,
  maxElapsedMs: 10 * 60 * 1000,
  intervalMs: 5000,
  backoffFactor: 1.4,
});
```

Transcript segments carry `speaker` and `transcript`. The text field is `transcript`, not `text`.

---

## The retry wrapper

`src/retry.js` is the piece most worth lifting into your own codebase.

```js
import { withRetry } from './src/retry.js';

await withRetry(() => doTheThing(), {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
  maxElapsedMs: 60_000,
  onRetry: (i) => console.warn(`retry ${i.attempt} in ${i.delayMs}ms after ${i.status}`),
});
```

Five rules it enforces:

1. **Only retry what is retryable.** 400/401/403/404/409 fail identically forever. Retrying them wastes time and buries the real message.
2. **Honor `Retry-After`.** On a 429 the server is telling you exactly how long to wait. Your own curve will just get you throttled again. The header can be seconds or an HTTP date, and `parseRetryAfter` handles both.
3. **Full jitter.** Delay is uniform over `[0, 2^n * base]`. Without it, every client throttled at the same instant retries at the same instant.
4. **Cap wall clock, not just attempts.** Eight attempts with exponential backoff quietly becomes minutes. Both caps are enforced.
5. **Idempotency-Key on writes.** Generated once per logical call and reused across every retry, so a retry the server already handled returns 507 instead of a second bot. Pass your own key when the unit of work is a queue job, so a re-run of the job replays rather than duplicates.

Network-level failures (DNS, reset, timeout) become `MeetStreamNetworkError` and are retryable. The client also sets a 30 second request timeout, so a hung socket cannot stall the process.

## How it works

```
index.js                CLI: offline matrix, --live probes, --table
src/errors.js           MeetStreamError, MeetStreamNetworkError, STATUS_GUIDE,
                        parseRetryAfter (seconds or HTTP date)
src/retry.js            withRetry, backoffDelay (full jitter), budgets
src/client.js           MeetStreamClient: Token auth, 507-as-success,
                        202-as-pending, per-call Idempotency-Key, timeouts
src/poll.js             pollUntilReady, PollTimeoutError, fetchTranscriptWhenReady
src/demos.js            the 11 offline scenarios + 4 live probes
src/mock-transport.js   deterministic fake fetch with real-shaped bodies
src/logger.js           timestamped console output
```

`src/client.js` takes a `fetchImpl` so the demos can inject a mock. The client code being exercised is the same code you would ship.

## Why some cases are mocked

Three failure modes cannot be produced against production responsibly:

- **409** needs a duplicate live bot on the same meeting, which costs money.
- **429** needs you to deliberately hammer the endpoint.
- **500 / 503** cannot be summoned on demand at all.

Those run against `src/mock-transport.js`, whose bodies and headers match what the API actually sends. Everything that can be demonstrated safely against production is, under `--live`.

## Troubleshooting

**Everything returns 401.** The header is `Authorization: Token <key>`. `Bearer` is a different scheme and the API rejects it.

**Retries make things worse.** You are probably retrying a 4xx. Check `err.retryable` before backing off, or use `withRetry`, which already does.

**Duplicate bots after a deploy or a queue redelivery.** Your `Idempotency-Key` is regenerated per attempt instead of per unit of work. Derive it from the job id, not `randomUUID()` at call time.

**A worker is stuck.** Something is polling a `202` without a cap. If the bot used a streaming-only provider, that poll will never finish.

**`in_call_recording_timeout must be at least 600 seconds.`** That floor is real. Values below 600 reject the whole `create_bot` request with a 400.

## Resources

- MeetStream Docs: https://docs.meetstream.ai
- API Reference: https://docs.meetstream.ai/api-reference
