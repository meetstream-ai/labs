import { MeetStreamError, MeetStreamNetworkError } from './errors.js';

/**
 * A reusable retry wrapper.
 *
 * Design rules, in order of how much pain each one saves you:
 *
 * 1. Only retry what is retryable. 400/401/403/404/409 will fail identically
 *    forever. Retrying them wastes time and hides the real problem.
 * 2. Honor Retry-After. On 429 the server is telling you exactly how long to
 *    wait. Ignoring it and using your own backoff gets you rate limited again.
 * 3. Full jitter. Without it, every client that got throttled at the same
 *    moment retries at the same moment.
 * 4. Cap the total wall clock, not just the attempt count. Ten attempts with
 *    exponential backoff can quietly become five minutes.
 * 5. On writes, pass a stable Idempotency-Key so a retry cannot duplicate work.
 *    That is what makes retrying a POST safe at all.
 */

export const DEFAULT_RETRY = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
  maxElapsedMs: 60_000,
  jitter: true,
};

export function backoffDelay(attempt, opts = DEFAULT_RETRY) {
  // attempt is 1-based: first retry uses baseDelayMs.
  const exponential = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** (attempt - 1));
  if (!opts.jitter) return exponential;
  // Full jitter (AWS architecture blog): uniform over [0, exponential].
  return Math.round(Math.random() * exponential);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {() => Promise<any>} fn        the operation, called once per attempt
 * @param {object} [options]
 * @param {number} [options.maxAttempts]
 * @param {number} [options.baseDelayMs]
 * @param {number} [options.maxDelayMs]
 * @param {number} [options.maxElapsedMs]
 * @param {boolean} [options.jitter]
 * @param {(info: object) => void} [options.onRetry] called before each sleep
 * @param {string} [options.label]       for logs
 */
export async function withRetry(fn, options = {}) {
  const opts = { ...DEFAULT_RETRY, ...options };
  const startedAt = Date.now();
  let lastError;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      const retryable =
        err instanceof MeetStreamNetworkError ||
        (err instanceof MeetStreamError && err.retryable);

      if (!retryable) {
        // Permanent. Surface it immediately with the API's own message intact.
        throw err;
      }
      if (attempt === opts.maxAttempts) break;

      // Retry-After wins over our own backoff curve. It is the server telling
      // us how long it actually needs.
      const serverDelay = err.retryAfterMs ?? null;
      const delay = serverDelay ?? backoffDelay(attempt, opts);

      const elapsed = Date.now() - startedAt;
      if (elapsed + delay > opts.maxElapsedMs) {
        const budgetErr = new Error(
          `Retry budget exhausted after ${elapsed}ms (limit ${opts.maxElapsedMs}ms). Last error: ${err.message}`,
        );
        budgetErr.cause = err;
        budgetErr.status = err.status ?? null;
        throw budgetErr;
      }

      opts.onRetry?.({
        attempt,
        maxAttempts: opts.maxAttempts,
        delayMs: delay,
        honoredRetryAfter: serverDelay !== null,
        status: err.status ?? null,
        message: err.message,
        label: opts.label,
      });

      await sleep(delay);
    }
  }

  throw lastError;
}
