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
      case 404: return "Not found: wrong bot id, or the bot has already left and been cleaned up.";
      case 409: return "Deduplication conflict: an equivalent request is already in flight.";
      case 429: return "Rate limited: back off and retry.";
      default:  return this.status >= 500 ? "MeetStream server-side error: retry later." : "";
    }
  }
}

export class MeetStreamClient {
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

  /** @returns {Promise<{ status: number, data: any, replayed?: boolean }>} */
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

      if (res.status === 507) return { status: 507, data, replayed: true };
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

      throw new MeetStreamError(message, res.status, path);
    }

    throw lastError ?? new MeetStreamError("Request failed", 0, path);
  }

  /** POST /bots/create_bot */
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

  /**
   * POST /bots/{bot_id}/send_message
   * Posts a chat message into the meeting as the bot.
   */
  async sendMessage(botId, message, metadata) {
    if (typeof message !== "string" || message.trim() === "") {
      throw new Error("send_message requires a non-empty message string.");
    }
    const body = { message };
    if (metadata) body.metadata = metadata;

    const { data, status, replayed } = await this.request(
      "POST",
      `/bots/${botId}/send_message`,
      { body, headers: { "Idempotency-Key": randomUUID() } }
    );
    return { ...data, _status: status, _replayed: Boolean(replayed) };
  }

  /**
   * POST /bots/{bot_id}/send_image
   * Posts an image (including an animated GIF) into the meeting chat.
   *
   *   { "img_url": "<public url>", "display_duration": 5 }
   *
   * The field is `img_url`, not `image_url`, and it must be a URL that
   * MeetStream's servers can fetch. There is no base64 form of this endpoint.
   *
   * @param {string} botId
   * @param {{ imgUrl: string, displayDuration?: number, metadata?: object }} options
   */
  async sendImage(botId, { imgUrl, displayDuration, metadata } = {}) {
    if (typeof imgUrl !== "string" || imgUrl.trim() === "") {
      throw new Error("send_image requires img_url: a publicly reachable URL.");
    }

    const body = { img_url: imgUrl };
    if (displayDuration !== undefined) body.display_duration = displayDuration;
    if (metadata) body.metadata = metadata;

    const { data, status, replayed } = await this.request(
      "POST",
      `/bots/${botId}/send_image`,
      { body, headers: { "Idempotency-Key": randomUUID() } }
    );
    return { ...data, _status: status, _replayed: Boolean(replayed) };
  }

  /** GET /bots/{bot_id}/remove_bot: note this really is a GET, not POST or DELETE. */
  async removeBot(botId) {
    const { data } = await this.request("GET", `/bots/${botId}/remove_bot`);
    return data;
  }
}
