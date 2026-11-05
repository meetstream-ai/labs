// Minimal MeetStream API client on Node 18's built-in fetch (CommonJS).
//
// The rules baked in here:
//   - Auth header is `Authorization: Token <key>`, literally "Token", not "Bearer".
//   - Error bodies are `{ "message": "..." }`; that message is surfaced verbatim.
//   - HTTP 202 means "still processing". It is returned to the caller, never thrown.
//   - HTTP 507 is an idempotent replay of a request that already succeeded: success.
//   - 4xx is never retried; identical input fails identically.

const API_BASE = (process.env.MEETSTREAM_BASE_URL || "https://api.meetstream.ai/api/v1").replace(
  /\/+$/,
  ""
);

const STATUS_HINTS = {
  400: "Validation error. The message names the field.",
  401: "No API key was sent. Set MEETSTREAM_API_KEY in .env.",
  403: "The API key was rejected. Check it is correct and still active.",
  404: "Not found. Check the bot_id / transcript_id, and the retention window.",
  429: "Rate limited. Wait and retry.",
};

class MeetStreamError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = "MeetStreamError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Perform one authenticated request.
 * @param {string} path  Path below /api/v1, e.g. "/bots/create_bot"
 * @param {{ method?: string, body?: object }} [options]
 * @returns {Promise<{ status: number, data: any }>}  2xx, 202 or 507
 * @throws {MeetStreamError} on any other status or a network failure
 */
async function request(path, { method = "GET", body } = {}) {
  const key = process.env.MEETSTREAM_API_KEY;
  if (!key) {
    throw new MeetStreamError(
      0,
      "MEETSTREAM_API_KEY is not set. Copy .env.example to .env and fill it in.",
      null
    );
  }

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Token ${key}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    throw new MeetStreamError(0, `Network error calling ${method} ${path}: ${cause.message}`, null);
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (res.ok || res.status === 202 || res.status === 507) return { status: res.status, data };

  const apiMessage =
    data && typeof data === "object" && typeof data.message === "string" ? data.message : null;
  const message = [`HTTP ${res.status}`, apiMessage, STATUS_HINTS[res.status]]
    .filter(Boolean)
    .join(" - ");
  throw new MeetStreamError(res.status, message, data);
}

module.exports = { request, MeetStreamError, API_BASE };
