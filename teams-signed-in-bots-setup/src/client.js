/**
 * Minimal MeetStream API client, with a dry-run mode.
 *
 * Ground rules baked in here (see https://docs.meetstream.ai/errors):
 *   - Auth header is `Authorization: Token <key>` - the literal word "Token", not "Bearer".
 *   - Error bodies look like { "message": "..." } or, on the Teams login
 *     endpoints, { "error": "..." }. Both are surfaced.
 *   - 202 means "still processing" - poll again, it is not a failure.
 *   - 507 means "idempotent replay" - the original request already succeeded. Treat as success.
 *   - 429/500/502/503/504 are transient and get retried with exponential backoff,
 *     unless the caller narrows that with `retryOn` (create_bot does: on a
 *     signed-in Teams bot a 429 means every account is busy, not a blip).
 *
 * Passwords: any `password` field in a request body is replaced with
 * "[redacted]" before it is printed, and scrubbed out of error messages. The
 * real value only ever goes into the HTTPS request body.
 */

export const DEFAULT_BASE_URL = 'https://api.meetstream.ai/api/v1';

export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const REDACTED = '[redacted]';
const SECRET_KEYS = new Set(['password', 'new_password']);

export class MeetStreamError extends Error {
  constructor(message, { status = null, body = null, path = null, method = null } = {}) {
    super(message);
    this.name = 'MeetStreamError';
    this.status = status;
    this.body = body;
    this.path = path;
    this.method = method;
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
  if (!Number.isInteger(parsed) || String(parsed) !== raw) {
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

/** Deep copy of `value` with every password field replaced by "[redacted]". */
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const copy = {};
    for (const [key, inner] of Object.entries(value)) {
      copy[key] = SECRET_KEYS.has(key) && inner !== undefined ? REDACTED : redact(inner);
    }
    return copy;
  }
  return value;
}

function secretsIn(body) {
  const found = [];
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (SECRET_KEYS.has(key) && typeof inner === 'string' && inner !== '') found.push(inner);
        else walk(inner);
      }
    }
  };
  walk(body);
  return found;
}

function scrub(text, secrets) {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(REDACTED);
  return out;
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

/** Pull a human-readable message out of whatever error shape the API returned. */
export function apiMessage(body) {
  if (body && typeof body === 'object') {
    for (const key of ['message', 'error', 'detail']) {
      if (typeof body[key] === 'string' && body[key].trim() !== '') return body[key];
    }
    return JSON.stringify(body).slice(0, 400);
  }
  if (typeof body === 'string' && body.trim() !== '') return body.slice(0, 400);
  return null;
}

function describe(status, body, method, path) {
  const message = apiMessage(body);
  return message
    ? `MeetStream ${status} on ${method} ${path}: ${message}`
    : `MeetStream ${status} on ${method} ${path}`;
}

function buildUrl(root, path, query) {
  let url = `${root}${path.startsWith('/') ? path : `/${path}`}`;
  if (query && Object.keys(query).length > 0) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) params.append(key, String(value));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }
  return url;
}

/**
 * Build a client bound to one API key.
 *
 * `request()` resolves to { status, data, pending, replayed, dryRun }:
 *   pending  -> HTTP 202, the resource is not ready yet
 *   replayed -> HTTP 507, an idempotent retry hit an already-completed request
 *   dryRun   -> nothing was sent; `data` is null
 *
 * With `dryRun: true` no API key is needed and nothing leaves the machine: each
 * call prints its method, URL and (redacted) body instead.
 */
export function createClient({
  dryRun = false,
  apiKey = dryRun
    ? optionalEnv('MEETSTREAM_API_KEY', 'dry-run')
    : requireEnv(
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
      retryOn = RETRYABLE_STATUS,
    } = options;

    const url = buildUrl(root, path, query);

    if (dryRun) {
      let shown = url;
      try {
        shown = decodeURIComponent(url);
      } catch {
        // keep the encoded form
      }
      console.log(`[dry-run] ${method} ${shown}`);
      if (body !== undefined) {
        const pretty = JSON.stringify(redact(body), null, 2).replace(/^/gm, '          ');
        console.log(pretty);
      }
      return { status: null, data: null, pending: false, replayed: false, dryRun: true };
    }

    const requestHeaders = {
      Authorization: `Token ${apiKey}`,
      Accept: 'application/json',
      ...headers,
    };
    if (idempotencyKey) requestHeaders['Idempotency-Key'] = idempotencyKey;

    let payload;
    if (body !== undefined) {
      requestHeaders['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const secrets = secretsIn(body);

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
        lastError = new MeetStreamError(
          scrub(`Network error calling ${method} ${path}: ${cause.message}`, secrets),
          { path, method }
        );
        continue;
      }

      const data = await readBody(res);

      if (res.status === 507) {
        // Idempotent replay: the original call already went through.
        return { status: 507, data, pending: false, replayed: true, dryRun: false };
      }
      if (res.ok) {
        return {
          status: res.status,
          data,
          pending: res.status === 202,
          replayed: false,
          dryRun: false,
        };
      }

      const error = new MeetStreamError(scrub(describe(res.status, data, method, path), secrets), {
        status: res.status,
        body: secrets.length > 0 ? redact(data) : data,
        path,
        method,
      });
      if (retryOn.has(res.status)) {
        lastError = error;
        continue;
      }
      throw error;
    }

    throw lastError ?? new MeetStreamError(`Request to ${method} ${path} failed`, { path, method });
  }

  return { request, baseUrl: root, dryRun };
}
