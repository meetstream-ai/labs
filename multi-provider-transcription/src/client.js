/**
 * Minimal MeetStream API client (Node 18+, built-in fetch).
 *
 * Two things every MeetStream client must get right:
 *   1. The auth header is `Authorization: Token <key>` - literally the word
 *      "Token", not "Bearer".
 *   2. HTTP 507 is not an error. It is an idempotent replay: a request with an
 *      `Idempotency-Key` you already used succeeded before, and the API is
 *      handing you back the original result instead of doing the work twice.
 */

const DEFAULT_BASE_URL = "https://api.meetstream.ai/api/v1";

export class MeetStreamError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "MeetStreamError";
    this.status = status;
    this.body = body;
  }
}

/** Hints appended to error messages so failures are self-explanatory. */
const STATUS_HINTS = {
  400: "Validation error. Check the request body against https://docs.meetstream.ai",
  401: "No API key was sent. Set MEETSTREAM_API_KEY.",
  403: "The API key was rejected. Check that it is correct and still active.",
  404: "Not found. Check the bot_id / transcript_id.",
  409: "Deduplication conflict - an equivalent request is already in flight.",
  429: "Rate limited. Back off and retry.",
  500: "Server error. Usually transient - retry with backoff.",
  503: "Service unavailable. Usually transient - retry with backoff.",
};

export function apiBaseUrl() {
  return process.env.MEETSTREAM_API_BASE_URL || DEFAULT_BASE_URL;
}

/** Fail fast, with a message that says exactly what to do. */
export function requireApiKey() {
  const key = process.env.MEETSTREAM_API_KEY;
  if (!key) {
    console.error("MEETSTREAM_API_KEY is not set.");
    console.error("Copy .env.example to .env and add your key from https://app.meetstream.ai");
    process.exit(1);
  }
  return key;
}

/**
 * Perform an authenticated API request.
 *
 * @param {string} path                    Path after /api/v1, e.g. "/bots/abc/detail"
 * @param {object} [options]
 * @param {string} [options.method]        HTTP method (default GET)
 * @param {object} [options.body]          JSON body (omit for GET)
 * @param {object} [options.headers]       Extra headers
 * @param {number[]} [options.acceptStatuses]
 *        Non-2xx statuses to return instead of throwing. Pass [202] when you
 *        intend to poll.
 * @returns {Promise<{ status: number, data: any }>}
 */
export async function api(path, options = {}) {
  const { method = "GET", body, headers = {}, acceptStatuses = [] } = options;

  const res = await fetch(`${apiBaseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Token ${requireApiKey()}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // Read as text first: error bodies are not always JSON.
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  // 507 = idempotent replay. The original request already succeeded.
  if (res.ok || res.status === 507 || acceptStatuses.includes(res.status)) {
    return { status: res.status, data };
  }

  const apiMessage =
    data && typeof data === "object" && typeof data.message === "string" ? data.message : null;
  const message = [`HTTP ${res.status}`, apiMessage, STATUS_HINTS[res.status]]
    .filter(Boolean)
    .join(" - ");

  throw new MeetStreamError(message, res.status, data);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
