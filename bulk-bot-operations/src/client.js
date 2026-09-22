import { MeetStreamError, MeetStreamNetworkError } from './errors.js';
import { withRetry } from './retry.js';

/**
 * MeetStream client for bulk work.
 *
 * The bits that matter when you are firing 50 of these:
 *   - `Token <key>` auth (not Bearer)
 *   - an Idempotency-Key supplied by the CALLER, derived from the job id, so a
 *     re-run of the batch replays instead of double-creating
 *   - 507 resolves as success with `replay: true`
 *   - retries only what is retryable, honoring Retry-After on 429
 *   - a per-request timeout so one hung socket cannot occupy a worker slot forever
 */
export class MeetStreamClient {
  constructor({
    apiKey,
    baseUrl = 'https://api.meetstream.ai/api/v1',
    timeoutMs = 30_000,
    retry = {},
    fetchImpl = globalThis.fetch,
    onRetry,
  }) {
    if (!apiKey) throw new Error('MEETSTREAM_API_KEY is required');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.retryOptions = retry;
    this.fetchImpl = fetchImpl;
    this.onRetry = onRetry;
  }

  async attempt(method, path, { body, headers = {} } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Token ${this.apiKey}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (cause) {
      throw new MeetStreamNetworkError({ cause, method, path });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => '');
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text.slice(0, 500) };
      }
    }

    // 507: this Idempotency-Key was already processed. The original request
    // succeeded, so this run should count it as done, not as a failure and
    // certainly not as a reason to retry without the key.
    if (res.status === 507) return { status: 507, data, replay: true };
    if (res.status === 202) return { status: 202, data, pending: true, replay: false };

    if (!res.ok) {
      throw new MeetStreamError({
        status: res.status,
        message: data?.message || `HTTP ${res.status}`,
        method,
        path,
        body: data,
        headers: res.headers,
      });
    }
    return { status: res.status, data, replay: false };
  }

  request(method, path, opts = {}) {
    return withRetry(() => this.attempt(method, path, opts), {
      ...this.retryOptions,
      label: `${method} ${path}`,
      onRetry: opts.onRetry ?? this.onRetry,
    });
  }

  /**
   * POST /bots/create_bot
   * `idempotencyKey` is REQUIRED here on purpose. In bulk work, letting the
   * client invent one per call is how you end up with duplicate bots after a
   * partial batch is re-run.
   */
  createBot(payload, { idempotencyKey, onRetry } = {}) {
    if (!idempotencyKey) {
      throw new Error(
        'createBot requires an idempotencyKey. Derive it from the job id so re-runs replay instead of duplicating.',
      );
    }
    return this.request('POST', '/bots/create_bot', {
      body: payload,
      headers: { 'Idempotency-Key': idempotencyKey },
      onRetry,
    });
  }

  /** GET /bots/{id}/status */
  botStatus(botId) {
    return this.request('GET', `/bots/${botId}/status`);
  }

  /** GET /bots/{id}/remove_bot  (a GET) */
  removeBot(botId) {
    return this.request('GET', `/bots/${botId}/remove_bot`);
  }
}
