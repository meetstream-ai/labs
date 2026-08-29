/**
 * Minimal MeetStream API client.
 *
 * Ground rules baked in here (see https://docs.meetstream.ai/errors):
 *   - Auth header is `Authorization: Token <key>` - the literal word "Token", not "Bearer".
 *   - Error bodies look like { "message": "..." }.
 *   - 202 means "still processing" - poll again, it is not a failure.
 *   - 507 means "idempotent replay" - the original request already succeeded. Treat as success.
 *   - 429/500/502/503/504 are transient and get retried with exponential backoff.
 */

export const DEFAULT_BASE_URL = 'https://api.meetstream.ai/api/v1';

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class MeetStreamError extends Error {
  constructor(message, { status = null, body = null, path = null } = {}) {
    super(message);
    this.name = 'MeetStreamError';
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Read a required environment variable or fail fast with an actionable message. */
export function requireEnv(name, hint = '') {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`Missing required environment variable ${name}.${hint ? ` ${hint}` : ''}`);
  }
  return value.trim();
}

/** Read an optional environment variable, returning `fallback` when unset/blank. */
export function optionalEnv(name, fallback = undefined) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  return value.trim();
}

/** Parse an environment variable as an integer, validating an inclusive range. */
export function intEnv(name, { fallback = undefined, min = -Infinity, max = Infinity } = {}) {
  const raw = optionalEnv(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) {
    throw new ConfigError(`${name} must be an integer, got "${raw}".`);
  }
  if (parsed < min || parsed > max) {
    throw new ConfigError(`${name} must be between ${min} and ${max}, got ${parsed}.`);
  }
  return parsed;
}

/** Parse an environment variable as a boolean ("true"/"1"/"yes" are true). */
export function boolEnv(name, fallback = false) {
  const raw = optionalEnv(name);
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readBody(res) {
  const text = await res.text();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describe(status, body, path) {
  const apiMessage =
    body && typeof body === 'object' && typeof body.message === 'string' ? body.message : null;
  if (apiMessage) return `MeetStream ${status} on ${path}: ${apiMessage}`;
  if (typeof body === 'string' && body.trim() !== '') {
    return `MeetStream ${status} on ${path}: ${body.slice(0, 400)}`;
  }
  return `MeetStream ${status} on ${path}`;
}

/**
 * Build a client bound to one API key.
 *
 * `request()` resolves to { status, data, pending, replayed }:
 *   pending  -> HTTP 202, the resource is not ready yet
 *   replayed -> HTTP 507, an idempotent retry hit an already-completed request
 */
export function createClient({
  apiKey = requireEnv(
    'MEETSTREAM_API_KEY',
    'Create one at https://app.meetstream.ai and put it in your .env file.'
  ),
  baseUrl = optionalEnv('MEETSTREAM_BASE_URL', DEFAULT_BASE_URL),
  maxRetries = 3,
  timeoutMs = 30_000,
} = {}) {
  const root = String(baseUrl).replace(/\/+$/, '');

  async function request(path, options = {}) {
    const {
      method = 'GET',
      body,
      query,
      headers = {},
      idempotencyKey,
      // Pass a FormData instance as `form` to send multipart/form-data.
      form,
    } = options;

    let url = `${root}${path.startsWith('/') ? path : `/${path}`}`;
    if (query && Object.keys(query).length > 0) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) params.append(key, String(value));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const requestHeaders = {
      Authorization: `Token ${apiKey}`,
      Accept: 'application/json',
      ...headers,
    };
    if (idempotencyKey) requestHeaders['Idempotency-Key'] = idempotencyKey;

    let payload;
    if (form !== undefined) {
      // Let fetch set the multipart boundary itself.
      payload = form;
    } else if (body !== undefined) {
      requestHeaders['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) await sleep(Math.min(2 ** attempt * 500, 8_000));

      let res;
      try {
        res = await fetch(url, {
          method,
          headers: requestHeaders,
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        lastError = new MeetStreamError(`Network error calling ${method} ${path}: ${cause.message}`, {
          path,
        });
        continue;
      }

      const data = await readBody(res);

      if (res.status === 507) {
        // Idempotent replay: the original call already went through.
        return { status: 507, data, pending: false, replayed: true };
      }
      if (res.ok) {
        return { status: res.status, data, pending: res.status === 202, replayed: false };
      }
      if (RETRYABLE_STATUS.has(res.status)) {
        lastError = new MeetStreamError(describe(res.status, data, path), {
          status: res.status,
          body: data,
          path,
        });
        continue;
      }
      throw new MeetStreamError(describe(res.status, data, path), {
        status: res.status,
        body: data,
        path,
      });
    }

    throw lastError ?? new MeetStreamError(`Request to ${method} ${path} failed`, { path });
  }

  return { request, baseUrl: root };
}
