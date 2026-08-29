import { log } from './log.js';
import { backoffDelay, sleep } from './util.js';

/**
 * Minimal MeetStream API client built on Node 18+ built-in `fetch`.
 *
 * Ground rules baked in here (see https://docs.meetstream.ai):
 *   - Base URL is https://api.meetstream.ai/api/v1
 *   - Auth header is `Authorization: Token <key>` - literally "Token", not "Bearer"
 *   - Error bodies are `{ "message": "..." }`
 *   - HTTP 202 means "still processing, poll again" - never an error
 *   - HTTP 507 means "idempotent replay of a request you already made" - treat as SUCCESS
 *   - 429 / 500 / 502 / 503 / 504 are transient and retried with backoff
 */

export const DEFAULT_BASE_URL = 'https://api.meetstream.ai/api/v1';

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export class MeetStreamError extends Error {
  /**
   * @param {number} status
   * @param {string} message - the API's own `message`, when it sent one
   * @param {unknown} body
   */
  constructor(status, message, body) {
    super(`MeetStream API error ${status}: ${message}`);
    this.name = 'MeetStreamError';
    this.status = status;
    this.apiMessage = message;
    this.body = body;
  }
}

/**
 * Pull the human-readable error out of a MeetStream response body.
 * @param {unknown} body
 * @param {Response} res
 * @returns {string}
 */
export function errorMessageFrom(body, res) {
  if (body && typeof body === 'object' && typeof body.message === 'string' && body.message) {
    return body.message;
  }
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 500);
  return res.statusText || 'no message in response body';
}

/**
 * Parse a response body as JSON when the server says it is JSON, otherwise text.
 * @param {Response} res
 * @returns {Promise<unknown>}
 */
export async function parseBody(res) {
  const contentType = res.headers.get('content-type') || '';
  try {
    if (contentType.includes('json')) return await res.json();
    return await res.text();
  } catch {
    return null;
  }
}

export class MeetStreamClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} [opts.baseUrl]
   * @param {number} [opts.timeoutMs] - applies to receiving response *headers*,
   *   not to streaming a long download body.
   * @param {number} [opts.maxRetries]
   * @param {number} [opts.retryBaseDelayMs]
   */
  constructor({
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = 30_000,
    maxRetries = 4,
    retryBaseDelayMs = 1000,
  }) {
    if (!apiKey) throw new Error('MeetStreamClient requires an apiKey.');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.retryBaseDelayMs = retryBaseDelayMs;
  }

  /**
   * Perform a request and return the raw `Response`, retrying transient
   * failures. No status checking - callers decide what each status means.
   *
   * @param {string} method
   * @param {string} path - path under the API base, e.g. "/bots/create_bot"
   * @param {object} [opts]
   * @param {unknown} [opts.body] - serialized as JSON when present
   * @param {Record<string,string>} [opts.headers]
   * @param {string} [opts.idempotencyKey]
   * @returns {Promise<Response>}
   */
  async raw(method, path, { body, headers = {}, idempotencyKey } = {}) {
    const url = `${this.baseUrl}${path}`;
    /** @type {RequestInit} */
    const init = {
      method,
      headers: {
        Authorization: `Token ${this.apiKey}`,
        Accept: 'application/json',
        ...headers,
      },
    };

    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (idempotencyKey) init.headers['Idempotency-Key'] = idempotencyKey;

    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, { ...init, signal: controller.signal });

        // 507 is an idempotent replay, i.e. success - never retry it even
        // though it lives in the 5xx range.
        if (res.status !== 507 && RETRYABLE_STATUSES.has(res.status) && attempt < this.maxRetries) {
          const detail = errorMessageFrom(await parseBody(res), res);
          const waitMs = retryAfterMs(res) ?? backoffDelay(attempt, this.retryBaseDelayMs);
          log.warn(
            `${method} ${path} -> ${res.status} (${detail}). ` +
              `Retrying in ${Math.round(waitMs)}ms (attempt ${attempt + 1}/${this.maxRetries}).`
          );
          clearTimeout(timer);
          await sleep(waitMs);
          continue;
        }

        return res;
      } catch (err) {
        lastError = err;
        const reason = err?.name === 'AbortError' ? `timed out after ${this.timeoutMs}ms` : err.message;
        if (attempt === this.maxRetries) {
          throw new Error(`${method} ${path} failed: ${reason}`);
        }
        const waitMs = backoffDelay(attempt, this.retryBaseDelayMs);
        log.warn(
          `${method} ${path} network failure (${reason}). ` +
            `Retrying in ${Math.round(waitMs)}ms (attempt ${attempt + 1}/${this.maxRetries}).`
        );
        await sleep(waitMs);
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new Error(`${method} ${path} failed after ${this.maxRetries + 1} attempts.`);
  }

  /**
   * Perform a request and decode the JSON body, throwing MeetStreamError for
   * any status not in `okStatuses`.
   *
   * @param {string} method
   * @param {string} path
   * @param {object} [opts]
   * @param {unknown} [opts.body]
   * @param {string} [opts.idempotencyKey]
   * @param {number[]} [opts.okStatuses] - defaults to 200/201/507
   * @returns {Promise<{ status: number, data: any }>}
   */
  async json(method, path, { body, idempotencyKey, okStatuses = [200, 201, 507] } = {}) {
    const res = await this.raw(method, path, { body, idempotencyKey });
    const data = await parseBody(res);

    if (!okStatuses.includes(res.status)) {
      throw new MeetStreamError(res.status, errorMessageFrom(data, res), data);
    }
    if (res.status === 507) {
      log.info(`${method} ${path} -> 507 idempotent replay (treated as success).`);
    }
    return { status: res.status, data };
  }

  /**
   * POST /bots/create_bot
   * @param {object} payload - see the MeetStream create-bot reference
   * @param {object} [opts]
   * @param {string} [opts.idempotencyKey]
   * @returns {Promise<{ bot_id: string, transcript_id: string|null, [k: string]: any }>}
   */
  async createBot(payload, { idempotencyKey } = {}) {
    const { data } = await this.json('POST', '/bots/create_bot', {
      body: payload,
      idempotencyKey,
    });
    if (!data || typeof data !== 'object' || !data.bot_id) {
      throw new Error(`create_bot succeeded but returned no bot_id: ${JSON.stringify(data)}`);
    }
    return data;
  }

  /**
   * GET /bots/{bot_id}/status
   * @param {string} botId
   * @returns {Promise<any>}
   */
  async getBotStatus(botId) {
    const { data } = await this.json('GET', `/bots/${botId}/status`);
    return data;
  }

  /**
   * GET /bots/{bot_id}/detail
   * @param {string} botId
   * @returns {Promise<any>}
   */
  async getBotDetail(botId) {
    const { data } = await this.json('GET', `/bots/${botId}/detail`);
    return data;
  }

  /**
   * GET /bots/{bot_id}/remove_bot - yes, a GET. Asks the bot to leave.
   * Best-effort: a 404 means it is already gone.
   * @param {string} botId
   * @returns {Promise<{ alreadyGone: boolean }>}
   */
  async removeBot(botId) {
    const res = await this.raw('GET', `/bots/${botId}/remove_bot`);
    const data = await parseBody(res);
    if (res.status === 404) {
      log.debug('remove_bot returned 404 - the bot had already left.');
      return { alreadyGone: true };
    }
    if (!res.ok && res.status !== 507) {
      throw new MeetStreamError(res.status, errorMessageFrom(data, res), data);
    }
    log.info(data?.message || 'Bot asked to leave the meeting.');
    return { alreadyGone: false };
  }

  /**
   * POST /bots/{bot_id}/pause_recording - empty body.
   * @param {string} botId
   * @returns {Promise<any>}
   */
  async pauseRecording(botId) {
    const { data } = await this.json('POST', `/bots/${botId}/pause_recording`);
    return data;
  }

  /**
   * POST /bots/{bot_id}/resume_recording - empty body.
   * @param {string} botId
   * @returns {Promise<any>}
   */
  async resumeRecording(botId) {
    const { data } = await this.json('POST', `/bots/${botId}/resume_recording`);
    return data;
  }

  // --- Storage config (bring your own bucket) --------------------------------

  /**
   * PUT /admin/configs?config_type=storage
   *
   * Body is a StorageConfigRequest. It carries `secret_key`, so this method
   * never logs its argument and the caller must not either.
   *
   * A 200 comes back with an empty body. MeetStream validates the credentials
   * before saving: in read_write mode with a live HeadBucket, in write_only
   * mode by writing a probe object under each configured prefix. So a 400 here
   * usually means the bucket or the credentials are wrong, not the JSON.
   *
   * @param {Record<string, any>} config
   * @param {string} [configType]
   * @returns {Promise<any>}
   */
  async setStorageConfig(config, configType = 'storage') {
    const { data } = await this.json(
      'PUT',
      `/admin/configs?config_type=${encodeURIComponent(configType)}`,
      { body: config }
    );
    return data;
  }

  /**
   * GET /admin/configs - the current storage configuration.
   * Credential fields are never included in the response.
   * @returns {Promise<any>}
   */
  async getStorageConfig() {
    const { data } = await this.json('GET', '/admin/configs');
    return data;
  }

  /**
   * DELETE /admin/configs?key_name=aws
   *
   * Removes the credentials and the configuration. New bots write to the
   * MeetStream platform bucket again. Files already in your bucket stay there.
   *
   * @param {string} [keyName]
   * @returns {Promise<any>}
   */
  async deleteStorageConfig(keyName = 'aws') {
    const { data } = await this.json(
      'DELETE',
      `/admin/configs?key_name=${encodeURIComponent(keyName)}`
    );
    return data;
  }
}

/**
 * Honour a Retry-After header when the API sends one on a 429.
 * @param {Response} res
 * @returns {number|null} milliseconds
 */
function retryAfterMs(res) {
  const header = res.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * Read a bot status payload and decide whether the bot has reached a terminal
 * state. MeetStream reports the reason in `bot_status`
 * (Stopped | NotAllowed | Denied | Error); we accept either `bot_status` or
 * `status` because both spellings show up depending on the endpoint.
 *
 * @param {any} statusPayload
 * @returns {{ status: string, terminal: boolean }}
 */
export function interpretBotStatus(statusPayload) {
  const raw =
    (typeof statusPayload === 'string' && statusPayload) ||
    statusPayload?.bot_status ||
    statusPayload?.status ||
    '';
  const normalized = String(raw).toLowerCase().replace(/[\s_-]/g, '');
  const terminal = ['stopped', 'notallowed', 'denied', 'error', 'done', 'completed', 'failed'].includes(
    normalized
  );
  return { status: String(raw) || 'unknown', terminal };
}
