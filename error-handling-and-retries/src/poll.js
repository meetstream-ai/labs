import { sleep } from './retry.js';

/**
 * Polling a 202 without a cap is the most common way to hang a worker forever.
 *
 * `GET /transcript/{transcript_id}/get_transcript` answers 202 while the
 * transcript is still being produced. For a post-call provider that resolves
 * within minutes. For a STREAMING-ONLY provider (deepgram_streaming,
 * assemblyai_streaming, jigsawstack_streaming, meetstream_streaming,
 * meeting_captions) there is no post-call transcript at all, so it answers
 * 202 for as long as you are willing to ask.
 *
 * So: always cap by attempts AND by wall clock, and give up with a clear
 * message that names the streaming-only case as the likely reason.
 */

export class PollTimeoutError extends Error {
  constructor({ attempts, elapsedMs, label }) {
    super(
      `Gave up polling ${label} after ${attempts} attempts / ${Math.round(elapsedMs / 1000)}s while still receiving HTTP 202. ` +
        'If this bot used a streaming-only transcription provider, no post-call transcript will ever exist and 202 is the permanent answer.',
    );
    this.name = 'PollTimeoutError';
    this.attempts = attempts;
    this.elapsedMs = elapsedMs;
  }
}

/**
 * Poll an operation that can answer "not ready yet".
 *
 * @param {() => Promise<{pending:boolean, data:any, status:number}>} fn
 * @param {object} [options]
 * @param {number} [options.maxAttempts]   hard cap on polls
 * @param {number} [options.maxElapsedMs]  hard cap on wall clock
 * @param {number} [options.intervalMs]    starting interval
 * @param {number} [options.maxIntervalMs] ceiling once backoff kicks in
 * @param {number} [options.backoffFactor] 1 = fixed interval
 * @param {(info:object)=>void} [options.onPending]
 * @param {string} [options.label]
 */
export async function pollUntilReady(fn, options = {}) {
  const {
    maxAttempts = 30,
    maxElapsedMs = 10 * 60 * 1000,
    intervalMs = 5_000,
    maxIntervalMs = 30_000,
    backoffFactor = 1.4,
    onPending,
    label = 'operation',
  } = options;

  const startedAt = Date.now();
  let wait = intervalMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await fn(attempt);

    if (!result.pending) return { ...result, attempts: attempt, elapsedMs: Date.now() - startedAt };

    const elapsed = Date.now() - startedAt;
    if (attempt === maxAttempts || elapsed + wait > maxElapsedMs) {
      throw new PollTimeoutError({ attempts: attempt, elapsedMs: elapsed, label });
    }

    onPending?.({ attempt, maxAttempts, waitMs: wait, elapsedMs: elapsed, label });
    await sleep(wait);
    wait = Math.min(maxIntervalMs, Math.round(wait * backoffFactor));
  }

  throw new PollTimeoutError({ attempts: maxAttempts, elapsedMs: Date.now() - startedAt, label });
}

/**
 * Convenience wrapper for the transcript endpoint.
 *
 * Reminder on the response shape: segments carry `speaker` and `transcript`.
 * The text field is `transcript`, not `text`.
 */
export async function fetchTranscriptWhenReady(client, transcriptId, options = {}) {
  const result = await pollUntilReady(() => client.getTranscript(transcriptId), {
    label: `transcript ${transcriptId}`,
    ...options,
  });
  return result.data;
}
