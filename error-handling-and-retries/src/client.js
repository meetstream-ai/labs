import { randomUUID } from 'node:crypto';
import { MeetStreamError, MeetStreamNetworkError, isIdempotentReplay, isPending } from './errors.js';
import { withRetry } from './retry.js';

/**
 * A production-grade MeetStream client.
 *
 * What "production-grade" means here, concretely:
 *   - `Token <key>` auth (not Bearer)
 *   - every non-2xx becomes a MeetStreamError carrying the API's own `message`
 *   - 507 resolves as a SUCCESS with `replay: true`
 *   - 202 resolves as `{ pending: true }` instead of throwing, so callers can poll
 *   - retries only what is safe to retry, honoring Retry-After
 *   - writes carry an Idempotency-Key so a retry cannot duplicate a bot
 *   - a request timeout, so a hung socket cannot stall your process forever
 */
export class MeetStreamClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} [opts.baseUrl]
   * @param {number} [opts.timeoutMs]
   * @param {object} [opts.retry]     overrides for withRetry
   * @param {typeof fetch} [opts.fetchImpl]  injectable for tests/demos
   * @param {(e:object)=>void} [opts.onRetry]
   */
  constructor({
    apiKey,
    baseUrl = 'https://api.meetstream.ai/api/v1',
    timeoutMs = 30_000,
    retry = {},
    fetchImpl = globalThis.fetch,
    onRetry,
  } = {}) {
    // Allow an absent key on purpose: the 401 demo needs to send no key at all.
    this.apiKey = apiKey ?? null;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.retryOptions = retry;
    this.fetchImpl = fetchImpl;
    this.onRetry = onRetry;
  }

  /**
   * One HTTP attempt. No retries here: `request` layers those on top.
   *
   * @returns {Promise<{status:number, data:any, replay:boolean, pending:boolean, headers:Headers}>}
   */
  async attempt(method, path, { body, headers = {}, signal } = {}) {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

    let res;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          // Literally `Token`. `Bearer` gets you a 401.
          ...(this.apiKey ? { Authorization: `Token ${this.apiKey}` } : {}),
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
        // Not JSON. Keep the raw text where the message would be so nothing is lost.
        data = { message: text.slice(0, 500) };
      }
    }

    // 507: idempotent replay. The original request already succeeded, so this
    // is a success. Returning it as an error is the classic way to turn a
    // harmless retry into a fake outage.
    if (isIdempotentReplay(res.status)) {
      return { status: 507, data, replay: true, pending: false, headers: res.headers };
    }

    // 202: not ready. Not an error either. Callers poll.
    if (isPending(res.status)) {
      return { status: 202, data, replay: false, pending: true, headers: res.headers };
    }

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

    return { status: res.status, data, replay: false, pending: false, headers: res.headers };
  }

  /** An attempt wrapped in the retry policy. */
  request(method, path, opts = {}) {
    return withRetry(() => this.attempt(method, path, opts), {
      ...this.retryOptions,
      ...(opts.retry ?? {}),
      label: `${method} ${path}`,
      onRetry: opts.onRetry ?? this.onRetry,
    });
  }

  // ---------------------------------------------------------------------
  // Endpoints
  // ---------------------------------------------------------------------

  /**
   * POST /bots/create_bot
   *
   * The Idempotency-Key is generated once here and reused across every retry
   * of this call. That is what makes retrying a POST safe: a retry that the
   * server already processed comes back as 507 rather than a second bot.
   *
   * Pass your own `idempotencyKey` when the natural unit of work is bigger
   * than one function call (a queue job, for example), so a re-run of the job
   * replays instead of duplicating.
   */
  createBot(payload, { idempotencyKey = randomUUID(), ...opts } = {}) {
    return this.request('POST', '/bots/create_bot', {
      body: payload,
      headers: { 'Idempotency-Key': idempotencyKey },
      ...opts,
    });
  }

  /** GET /bots/{id}/status */
  botStatus(botId, opts = {}) {
    return this.request('GET', `/bots/${botId}/status`, opts);
  }

  /** GET /bots/{id}/detail  - where transcript_id lives */
  botDetail(botId, opts = {}) {
    return this.request('GET', `/bots/${botId}/detail`, opts);
  }

  /** GET /bots/{id}/remove_bot  (a GET) */
  removeBot(botId, opts = {}) {
    return this.request('GET', `/bots/${botId}/remove_bot`, opts);
  }

  /**
   * GET /transcript/{transcript_id}/get_transcript
   * Keyed by transcript_id, NOT bot_id. Returns 202 until it is ready, and
   * 202 forever for streaming-only bots, which is why the poller has a cap.
   */
  getTranscript(transcriptId, { raw = false, ...opts } = {}) {
    return this.request('GET', `/transcript/${transcriptId}/get_transcript?raw=${raw}`, opts);
  }
}
