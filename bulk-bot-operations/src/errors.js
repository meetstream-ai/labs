/**
 * The complete MeetStream error surface, and what you should actually do
 * about each status code.
 *
 * Error bodies always look like: { "message": "..." }
 * Never assume a different shape. Never swallow that message: it is the
 * single most useful thing in a failed request.
 */

export class MeetStreamError extends Error {
  /**
   * @param {object} opts
   * @param {number} opts.status      HTTP status
   * @param {string} opts.message     the API's `message` field, verbatim when present
   * @param {string} opts.method
   * @param {string} opts.path
   * @param {object|null} [opts.body] parsed response body
   * @param {Headers|null} [opts.headers]
   */
  constructor({ status, message, method, path, body = null, headers = null }) {
    super(message);
    this.name = 'MeetStreamError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
    this.headers = headers;

    const meta = STATUS_GUIDE[status] ?? UNKNOWN_STATUS;
    this.retryable = meta.retryable;
    this.category = meta.category;
    this.hint = meta.hint;
    this.retryAfterMs = parseRetryAfter(headers);
  }

  toString() {
    return `MeetStreamError ${this.status} on ${this.method} ${this.path}: ${this.message}`;
  }
}

/** Thrown when the transport itself failed (DNS, TCP reset, timeout). */
export class MeetStreamNetworkError extends Error {
  constructor({ cause, method, path }) {
    super(`Network failure on ${method} ${path}: ${cause?.message ?? cause}`);
    this.name = 'MeetStreamNetworkError';
    this.cause = cause;
    this.method = method;
    this.path = path;
    this.retryable = true;
    this.category = 'network';
    this.status = null;
    this.hint = 'Transport-level failure. Safe to retry, but use an Idempotency-Key on writes.';
  }
}

const UNKNOWN_STATUS = {
  category: 'unknown',
  retryable: false,
  hint: 'Undocumented status. Log the full body and do not retry blindly.',
};

/**
 * The decision table. `retryable` is the ONLY thing the retry wrapper looks at.
 *
 * Two entries deserve a second read:
 *   202 is not an error at all. It means "still processing, ask again later".
 *   507 is not an error either. It means "you already sent this exact
 *       Idempotency-Key". The original request succeeded. Treat it as SUCCESS.
 */
export const STATUS_GUIDE = {
  200: { category: 'success', retryable: false, hint: 'OK.' },
  201: { category: 'success', retryable: false, hint: 'Created.' },
  202: {
    category: 'pending',
    retryable: false,
    hint: 'Still processing. Poll again after a delay, with a hard cap on attempts.',
  },
  400: {
    category: 'validation',
    retryable: false,
    hint: 'Your request body is wrong. The `message` names the field. Retrying identical input cannot help.',
  },
  401: {
    category: 'auth',
    retryable: false,
    hint: 'No API key was sent. Check that the Authorization header exists and is `Token <key>`, not `Bearer <key>`.',
  },
  403: {
    category: 'auth',
    retryable: false,
    hint: 'A key was sent but it is not valid (wrong key, revoked, or wrong environment).',
  },
  404: {
    category: 'not_found',
    retryable: false,
    hint: 'No such resource. Usually a bot_id from another environment, or one whose data was deleted.',
  },
  409: {
    category: 'conflict',
    retryable: false,
    hint: 'Deduplication conflict: a matching bot already exists for this meeting. Reuse it instead of creating another.',
  },
  429: {
    category: 'rate_limit',
    retryable: true,
    hint: 'Rate limited. Honor the Retry-After header if present, otherwise back off exponentially.',
  },
  500: {
    category: 'server',
    retryable: true,
    hint: 'Transient server error. Retry with exponential backoff.',
  },
  502: { category: 'server', retryable: true, hint: 'Bad gateway. Retry with exponential backoff.' },
  503: {
    category: 'server',
    retryable: true,
    hint: 'Service unavailable. Retry with exponential backoff, and honor Retry-After if present.',
  },
  504: { category: 'server', retryable: true, hint: 'Gateway timeout. Retry with exponential backoff.' },
  507: {
    category: 'idempotent_replay',
    retryable: false,
    hint: 'You replayed an Idempotency-Key. The original request already succeeded. This is a SUCCESS.',
  },
};

/**
 * Retry-After can be either a delay in seconds or an HTTP date.
 * Returns milliseconds, or null when the header is absent or unparseable.
 */
export function parseRetryAfter(headers) {
  const raw = headers?.get?.('retry-after');
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const when = Date.parse(raw);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());

  return null;
}

/** True when the status means "already done, stop worrying". */
export function isIdempotentReplay(status) {
  return status === 507;
}

/** True when the status means "not ready yet, poll again". */
export function isPending(status) {
  return status === 202;
}

/** Explain a status without needing an error instance. */
export function explain(status) {
  const meta = STATUS_GUIDE[status] ?? UNKNOWN_STATUS;
  return `${status} ${meta.category}: ${meta.hint}`;
}
