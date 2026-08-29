/**
 * Minimal MeetStream API client.
 *
 * Built on Node 18's global `fetch` - no HTTP library needed.
 *
 * Contract notes that matter (from the MeetStream API reference):
 * - Auth header is `Authorization: Token <key>`, literally "Token", NOT "Bearer".
 * - Error bodies look like `{ "message": "..." }`.
 * - HTTP 202 means "still processing, poll again" - it is NOT an error.
 * - HTTP 507 is an idempotent replay of a request you already made - treat as success.
 * - 429 / 500 / 502 / 503 / 504 are transient and worth retrying with backoff.
 */

export const DEFAULT_BASE_URL = 'https://api.meetstream.ai/api/v1';

/** Bot statuses that mean the bot will never do anything else. */
export const TERMINAL_STATUSES = new Set([
  'Stopped',
  'NotAllowed',
  'Denied',
  'Error',
  'Done',
]);

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

const STATUS_HINTS = {
  400: 'Validation error - check the request body against https://docs.meetstream.ai/api-reference',
  401: 'No API key was sent. Set MEETSTREAM_API_KEY in your .env file.',
  403: 'API key rejected. Confirm the key is active for this workspace.',
  404: 'Not found. Double-check the bot id (and that its data has not been deleted by retention).',
  409: 'Duplicate request - the API deduped it.',
  429: 'Rate limited.',
};

export class MeetStreamError extends Error {
  /**
   * @param {number} status HTTP status (0 for network/timeout failures)
   * @param {string} message human-readable message, preferring the API's own `message`
   * @param {unknown} body parsed response body, if there was one
   */
  constructor(status, message, body) {
    super(message);
    this.name = 'MeetStreamError';
    this.status = status;
    this.body = body;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read the API key from the environment, failing fast with a useful message. */
export function readApiKey() {
  const key = (process.env.MEETSTREAM_API_KEY || '').trim();
  if (!key) {
    throw new Error(
      'MEETSTREAM_API_KEY is not set.\n' +
        '  1. cp .env.example .env\n' +
        '  2. paste your key from https://app.meetstream.ai into MEETSTREAM_API_KEY'
    );
  }
  return key;
}

/** Read an integer env var, falling back to a default. */
export function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : fallback;
}

function apiMessage(payload) {
  if (payload && typeof payload === 'object') {
    for (const key of ['message', 'detail', 'error']) {
      if (typeof payload[key] === 'string' && payload[key].trim()) return payload[key].trim();
    }
  }
  if (typeof payload === 'string' && payload.trim()) return payload.trim().slice(0, 500);
  return null;
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  const type = res.headers.get('content-type') || '';
  if (type.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class MeetStreamClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} [opts.baseUrl]
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.maxRetries]
   * @param {number} [opts.retryBaseDelayMs]
   * @param {(msg: string) => void} [opts.onRetry]
   */
  constructor({
    apiKey,
    baseUrl = process.env.MEETSTREAM_BASE_URL || DEFAULT_BASE_URL,
    timeoutMs = envInt('REQUEST_TIMEOUT_MS', 30_000),
    maxRetries = envInt('MAX_RETRIES', 3),
    retryBaseDelayMs = envInt('RETRY_BASE_DELAY_MS', 1_000),
    onRetry,
  } = {}) {
    if (!apiKey) throw new Error('MeetStreamClient requires an apiKey.');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.retryBaseDelayMs = retryBaseDelayMs;
    this.onRetry = onRetry || (() => {});
  }

  /**
   * Perform a request.
   *
   * Resolves with `{ status, data }` for 2xx, 202 and 507. Throws a
   * MeetStreamError for anything else (after exhausting retries on
   * transient statuses).
   *
   * @param {string} path path below the API base, e.g. `/bots/abc/summary`
   * @param {{ method?: string, body?: unknown, headers?: Record<string,string> }} [opts]
   * @returns {Promise<{ status: number, data: any }>}
   */
  async request(path, { method = 'GET', body, headers = {} } = {}) {
    const url = `${this.baseUrl}${path}`;
    const label = `${method} ${path}`;

    for (let attempt = 0; ; attempt += 1) {
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Token ${this.apiKey}`,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (attempt >= this.maxRetries) {
          throw new MeetStreamError(0, `Network error on ${label}: ${err.message}`, null);
        }
        await this.#backoff(attempt, label, err.message);
        continue;
      }

      const data = await readBody(res);

      // 507 = idempotent replay of a request that already succeeded.
      // 202 = accepted but still processing; the caller decides whether to poll.
      if (res.ok || res.status === 202 || res.status === 507) {
        return { status: res.status, data };
      }

      if (RETRYABLE_STATUSES.has(res.status) && attempt < this.maxRetries) {
        await this.#backoff(attempt, label, `HTTP ${res.status}`);
        continue;
      }

      const detail = apiMessage(data);
      const hint = STATUS_HINTS[res.status];
      const parts = [`${label} failed with HTTP ${res.status}`];
      if (detail) parts.push(detail);
      if (hint) parts.push(hint);
      throw new MeetStreamError(res.status, parts.join(' - '), data);
    }
  }

  async #backoff(attempt, label, reason) {
    const delay = Math.round(this.retryBaseDelayMs * 2 ** attempt * (0.75 + Math.random() * 0.5));
    this.onRetry(
      `${label} (${reason}) - retrying in ${delay}ms (attempt ${attempt + 2}/${this.maxRetries + 1})`
    );
    await sleep(delay);
  }

  // --- Endpoint helpers -------------------------------------------------

  /** POST /bots/create_bot */
  async createBot(payload, { idempotencyKey } = {}) {
    const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
    const { status, data } = await this.request('/bots/create_bot', {
      method: 'POST',
      body: payload,
      headers,
    });
    return { replayed: status === 507, data };
  }

  /** GET /bots/{bot_id}/status -> { bot_id, status, custom_attributes } */
  async getStatus(botId) {
    const { data } = await this.request(`/bots/${encodeURIComponent(botId)}/status`);
    return data;
  }

  /** GET /bots/{bot_id}/detail -> { bot_details: {...} } */
  async getDetail(botId) {
    const { status, data } = await this.request(`/bots/${encodeURIComponent(botId)}/detail`);
    return { status, data };
  }

  /** GET /bots/{bot_id}/summary -> BotDetailsResponse shape; 202 while generating */
  async getSummary(botId) {
    return this.request(`/bots/${encodeURIComponent(botId)}/summary`);
  }

  /** GET /bots/{bot_id}/get_participants -> top-level array of participants */
  async getParticipants(botId) {
    return this.request(`/bots/${encodeURIComponent(botId)}/get_participants`);
  }

  /** GET /bots/{bot_id}/get_speaker_timeline -> { chunks, lastUpdated, audioFilePath, totalFileSize } */
  async getSpeakerTimeline(botId) {
    return this.request(`/bots/${encodeURIComponent(botId)}/get_speaker_timeline`);
  }

  /** GET /bots/{bot_id}/get_chats -> in-meeting chat messages */
  async getChats(botId) {
    return this.request(`/bots/${encodeURIComponent(botId)}/get_chats`);
  }

  /** GET /bots/{bot_id}/remove_bot - yes, GET. Asks the bot to leave the call. */
  async removeBot(botId) {
    return this.request(`/bots/${encodeURIComponent(botId)}/remove_bot`);
  }

  /**
   * Poll GET /bots/{id}/status until it reports a terminal status.
   *
   * @param {string} botId
   * @param {{ intervalMs?: number, maxAttempts?: number, onTick?: (status: string, attempt: number) => void }} [opts]
   * @returns {Promise<{ status: string|null, timedOut: boolean }>}
   */
  async waitForTerminalStatus(botId, { intervalMs = 15_000, maxAttempts = 120, onTick } = {}) {
    let last = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const body = await this.getStatus(botId);
      const current = typeof body?.status === 'string' ? body.status : null;
      if (current !== last) {
        last = current;
        if (onTick) onTick(current, attempt);
      }
      if (current && TERMINAL_STATUSES.has(current)) {
        return { status: current, timedOut: false };
      }
      if (attempt < maxAttempts) await sleep(intervalMs);
    }
    return { status: last, timedOut: true };
  }
}

/**
 * Poll a request-returning function until it stops answering HTTP 202.
 *
 * @template T
 * @param {() => Promise<{ status: number, data: T }>} fn
 * @param {{ intervalMs?: number, maxAttempts?: number, label?: string, onWait?: (attempt: number, maxAttempts: number) => void }} [opts]
 * @returns {Promise<{ data: T, attempts: number }>}
 */
export async function pollUntilReady(
  fn,
  { intervalMs = 10_000, maxAttempts = 30, label = 'resource', onWait } = {}
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { status, data } = await fn();
    if (status !== 202) return { data, attempts: attempt };
    if (onWait) onWait(attempt, maxAttempts);
    if (attempt < maxAttempts) await sleep(intervalMs);
  }
  throw new MeetStreamError(
    202,
    `${label} was still processing (HTTP 202) after ${maxAttempts} attempts. ` +
      'Raise the poll cap, or check that this bot actually produces this artifact.',
    null
  );
}
