/**
 * Minimal MeetStream REST client.
 *
 *   Base URL : https://api.meetstream.ai/api/v1
 *   Auth     : Authorization: Token <api key>     ← literally "Token", not "Bearer"
 *   Errors   : { "message": "..." }
 *
 * Status handling:
 *   200 / 201  success
 *   202        still processing: the caller decides whether to poll
 *   4xx        fail fast (retrying a malformed request or a bad key never helps)
 *   429 / 5xx  retried with exponential backoff, honouring Retry-After
 *   507        idempotent replay of a request we already made: treated as SUCCESS
 */

import { randomUUID } from "node:crypto";

const DEFAULT_BASE_URL = "https://api.meetstream.ai/api/v1";
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const backoff = (attempt) => Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);

export class MeetStreamError extends Error {
  constructor(message, status, path) {
    super(message);
    this.name = "MeetStreamError";
    this.status = status;
    this.path = path;
  }

  get hint() {
    switch (this.status) {
      case 400: return "Validation error: check the request body against docs.meetstream.ai.";
      case 401: return "No API key was sent. Set MEETSTREAM_API_KEY in .env.";
      case 403: return "API key rejected. Regenerate it in the MeetStream dashboard.";
      case 404: return "Not found: wrong bot id, or the bot has already been deleted.";
      case 409: return "Deduplication conflict: an equivalent request is already in flight.";
      case 429: return "Rate limited: back off and retry.";
      default:  return this.status >= 500 ? "MeetStream server-side error: retry later." : "";
    }
  }
}

export class MeetStreamClient {
  /**
   * @param {string} apiKey  MeetStream API key
   * @param {{ baseUrl?: string, logger?: { info: Function } }} [options]
   */
  constructor(apiKey, options = {}) {
    if (!apiKey) {
      throw new Error("MeetStreamClient requires an API key (MEETSTREAM_API_KEY).");
    }
    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl || process.env.MEETSTREAM_BASE_URL || DEFAULT_BASE_URL;
    this.logger = options.logger ?? null;
  }

  #headers(extra) {
    return {
      Authorization: `Token ${this.apiKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  /**
   * @returns {Promise<{ status: number, data: any, replayed?: boolean }>}
   */
  async request(method, path, { body, headers } = {}) {
    const url = `${this.baseUrl}${path}`;
    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let res;
      let text;

      try {
        res = await fetch(url, {
          method,
          headers: this.#headers(headers),
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        text = await res.text();
      } catch (err) {
        // Network-level failure: DNS, reset connection, timeout.
        lastError = new MeetStreamError(`Network error: ${err.message}`, 0, path);
        if (attempt < MAX_RETRIES) {
          this.logger?.info(`Network error on ${path}: retrying in ${backoff(attempt)}ms`);
          await sleep(backoff(attempt));
          continue;
        }
        throw lastError;
      }

      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }

      // 507 = idempotent replay. The original request already succeeded.
      if (res.status === 507) return { status: 507, data, replayed: true };

      // 202 = accepted but still processing. Handed back for the caller to poll.
      if (res.ok || res.status === 202) return { status: res.status, data };

      const message = data?.message || text || `HTTP ${res.status}`;

      if (res.status === 429 || res.status >= 500) {
        lastError = new MeetStreamError(message, res.status, path);
        if (attempt < MAX_RETRIES) {
          const retryAfter = res.headers.get("retry-after");
          const delay = retryAfter ? Number(retryAfter) * 1000 : backoff(attempt);
          this.logger?.info(
            `${method} ${path} → ${res.status}: retrying in ${(delay / 1000).toFixed(1)}s ` +
            `(attempt ${attempt + 1}/${MAX_RETRIES})`
          );
          await sleep(Number.isFinite(delay) ? delay : backoff(attempt));
          continue;
        }
        throw lastError;
      }

      // Any other 4xx: not worth retrying.
      throw new MeetStreamError(message, res.status, path);
    }

    throw lastError ?? new MeetStreamError("Request failed", 0, path);
  }

  /**
   * POST /bots/create_bot
   * An Idempotency-Key makes a retried create safe: the replay comes back as 507.
   * @returns {Promise<{ bot_id: string, transcript_id: string|null, meeting_url: string, status: string }>}
   */
  async createBot(payload) {
    const { data, replayed } = await this.request("POST", "/bots/create_bot", {
      body: payload,
      headers: { "Idempotency-Key": randomUUID() },
    });
    if (replayed) this.logger?.info("create_bot replayed an earlier identical request (507).");
    return data;
  }

  /** GET /bots/{bot_id}/status */
  async getStatus(botId) {
    const { data } = await this.request("GET", `/bots/${botId}/status`);
    return data;
  }

  /** GET /bots/{bot_id}/remove_bot: note this really is a GET, not POST or DELETE. */
  async removeBot(botId) {
    const { data } = await this.request("GET", `/bots/${botId}/remove_bot`);
    return data;
  }
}
