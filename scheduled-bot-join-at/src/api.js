/**
 * Minimal MeetStream API client.
 *
 * Node 18+ only: this uses the built-in global fetch, so there is no HTTP
 * dependency to install. Every MeetStream call goes through `request()` or
 * `call()` below so error handling stays in one place.
 */

export const BASE_URL =
  process.env.MEETSTREAM_API_BASE_URL || "https://api.meetstream.ai/api/v1";

/** Plain-English hints for the status codes the MeetStream API returns. */
export const STATUS_HINTS = {
  202: "Still processing. Poll again in a few seconds.",
  400: "Validation error. Check the request body against the field reference.",
  401: "No API key was sent. Set MEETSTREAM_API_KEY in your .env file.",
  403: "The API key was rejected. Make sure you copied the whole key.",
  404: "Not found. Wrong id, or the resource was already deleted.",
  409: "Conflict. A deduplication_key was reused for a different request.",
  429: "Rate limited. Back off and retry.",
  500: "Server error. Usually transient, retry.",
  503: "Service unavailable. Usually transient, retry.",
  507: "Idempotent replay. This is a SUCCESS: the original resource is returned.",
};

export class MeetStreamError extends Error {
  constructor(status, message, body) {
    super(message || `HTTP ${status}`);
    this.name = "MeetStreamError";
    this.status = status;
    this.body = body;
    this.hint = STATUS_HINTS[status] ?? null;
  }
}

/**
 * Builds the auth header. Note it is literally `Token`, not `Bearer`.
 */
function authHeader() {
  const key = process.env.MEETSTREAM_API_KEY;
  if (!key) {
    throw new Error(
      "MEETSTREAM_API_KEY is not set. Copy .env.example to .env and fill it in."
    );
  }
  return `Token ${key}`;
}

/** Pulls the API's error text out of whatever shape came back. */
export function errorMessage(body, status) {
  if (body && typeof body === "object" && typeof body.message === "string") {
    return body.message;
  }
  if (typeof body === "string" && body.trim()) {
    return body.trim().slice(0, 500);
  }
  return `HTTP ${status}`;
}

/**
 * Low-level request. Never throws on an HTTP error status, it returns it,
 * so the caller can decide what counts as success.
 *
 * @returns {Promise<{status:number, ok:boolean, data:any}>}
 */
export async function request(path, options = {}) {
  const { method = "GET", body, headers = {}, query } = options;

  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authHeader(),
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const raw = await res.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  }

  return { status: res.status, ok: res.ok, data };
}

/**
 * Request that throws a MeetStreamError on anything unexpected.
 *
 * `accept` lists extra non-2xx codes that are legitimate for this call, for
 * example 202 (still processing), 507 (idempotent replay) or 409 (dedup
 * conflict) when you want to inspect them yourself.
 */
export async function call(path, options = {}) {
  const { accept = [], ...rest } = options;
  const res = await request(path, rest);
  if (res.ok || accept.includes(res.status)) return res;
  throw new MeetStreamError(res.status, errorMessage(res.data, res.status), res.data);
}

/** Consistent error output for the CLI entry points. */
export function reportError(err) {
  if (err instanceof MeetStreamError) {
    console.error(`\nAPI error ${err.status}: ${err.message}`);
    if (err.hint) console.error(`Hint: ${err.hint}`);
    if (err.body && typeof err.body === "object") {
      console.error(JSON.stringify(err.body, null, 2));
    }
  } else {
    console.error(`\n${err.message}`);
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
