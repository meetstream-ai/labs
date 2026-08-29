// Minimal MeetStream API client, scoped to the /zoom/oauth routes.
//
// Three rules that trip people up:
//   1. The auth header is `Authorization: Token <key>` - literally "Token", not "Bearer".
//   2. HTTP 507 means "idempotent replay": the original request already succeeded,
//      so it must be treated as success, not as an error.
//   3. HTTP 202 means "still processing". Poll again, but cap the retries so a
//      stuck resource cannot spin forever.

const DEFAULT_BASE_URL = 'https://api.meetstream.ai/api/v1';

const MAX_202_POLLS = 5;
const POLL_DELAY_MS = 2000;

const STATUS_HELP = {
  400:
    'MeetStream rejected the request. On the connections endpoint this is almost always ' +
    'an authorization code that was already used or has expired, or a redirect_uri that ' +
    'does not byte-for-byte match the one sent to authorize-url.',
  401: 'No API key was sent. Set MEETSTREAM_API_KEY in .env.',
  403: 'MeetStream denied the API key. Check MEETSTREAM_API_KEY.',
  404: 'MeetStream has no Zoom connection with that zoom_user_id.',
  409: 'MeetStream treated this as a duplicate request.',
  429: 'Rate limited by MeetStream. Slow down and retry.',
  500: 'MeetStream had a server error. Retry shortly.',
  503: 'MeetStream is temporarily unavailable. Retry shortly.'
};

export class MeetStreamError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'MeetStreamError';
    this.status = status;
    this.body = body;
  }
}

export function baseUrl() {
  const configured = process.env.MEETSTREAM_API_BASE_URL?.trim();
  return (configured || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Perform one MeetStream API call.
 *
 * Returns { status, data, replayed }.
 *   replayed -> HTTP 507, an identical idempotent request already succeeded.
 *
 * HTTP 202 is retried internally up to MAX_202_POLLS times, then surfaced as an
 * error rather than looping forever.
 */
export async function request(path, options = {}) {
  const { apiKey, method = 'GET', body, query } = options;
  if (!apiKey) throw new Error('A MeetStream API key is required for every request.');

  const url = new URL(`${baseUrl()}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  const headers = { Authorization: `Token ${apiKey}`, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  for (let attempt = 0; attempt <= MAX_202_POLLS; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (cause) {
      throw new Error(`Could not reach MeetStream at ${url.host}: ${cause.message}`);
    }

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    // 507 is an idempotent replay. It lives in the 5xx range but it is a success.
    if (response.status === 507) return { status: 507, data, replayed: true };

    if (response.status === 202) {
      if (attempt === MAX_202_POLLS) {
        throw new MeetStreamError(
          202,
          `MeetStream still returned 202 (processing) after ${MAX_202_POLLS + 1} attempts. Try again later.`,
          data
        );
      }
      await sleep(POLL_DELAY_MS);
      continue;
    }

    if (!response.ok) {
      const detail =
        (data && typeof data === 'object' && !Array.isArray(data) && (data.message || data.error)) ||
        (typeof data?.raw === 'string' ? data.raw.slice(0, 300) : '');
      const help = STATUS_HELP[response.status] || `MeetStream returned HTTP ${response.status}.`;
      throw new MeetStreamError(response.status, detail ? `${help} ${detail}` : help, data);
    }

    return { status: response.status, data, replayed: false };
  }

  // Unreachable: the loop either returns or throws.
  throw new Error('Request loop exited without a result.');
}

/**
 * GET /zoom/oauth/authorize-url?redirect_uri=...&state=...
 *
 * `redirect_uri` is required and must match the Zoom app's registered redirect
 * URL byte-for-byte. `state` is optional and is round-tripped back to your
 * callback by Zoom.
 *
 * Response: { authorize_url }
 */
export async function getAuthorizeUrl(apiKey, { redirectUri, state }) {
  const { data } = await request('/zoom/oauth/authorize-url', {
    apiKey,
    query: { redirect_uri: redirectUri, state }
  });
  const authorizeUrl = data?.authorize_url;
  if (!authorizeUrl) {
    throw new Error(`MeetStream returned no authorize_url. Raw response: ${JSON.stringify(data)}`);
  }
  return { authorizeUrl, raw: data };
}

/**
 * POST /zoom/oauth/connections
 *
 * Body: { code, redirect_uri, metadata? }
 *   code         the ?code= value Zoom sent to your redirect URI
 *   redirect_uri the exact same URL used on authorize-url
 *   metadata     optional flat map of your own strings (values must be strings)
 *
 * Response: a ZoomOAuthConnection. No token material is ever returned.
 */
export async function createConnection(apiKey, { code, redirectUri, metadata }) {
  const body = { code, redirect_uri: redirectUri };
  if (metadata && Object.keys(metadata).length > 0) body.metadata = metadata;

  const { data, replayed } = await request('/zoom/oauth/connections', {
    apiKey,
    method: 'POST',
    body
  });

  if (!data?.zoom_user_id) {
    if (replayed) {
      throw new Error(
        'MeetStream replayed an earlier identical request (HTTP 507) but returned no zoom_user_id. ' +
          'Run "node index.js list" to find the connection that was already stored.'
      );
    }
    throw new Error(
      `MeetStream stored the connection but returned no zoom_user_id. Raw response: ${JSON.stringify(data)}`
    );
  }

  return { connection: data, replayed };
}

/** GET /zoom/oauth/connections - every Zoom connection on the account. */
export async function listConnections(apiKey) {
  const { data } = await request('/zoom/oauth/connections', { apiKey });
  if (Array.isArray(data)) return data;
  // Defensive: accept a wrapped array too rather than crashing on a shape change.
  if (Array.isArray(data?.connections)) return data.connections;
  return [];
}

/** GET /zoom/oauth/connections/{zoom_user_id} */
export async function getConnection(apiKey, zoomUserId) {
  const { data } = await request(`/zoom/oauth/connections/${encodeURIComponent(zoomUserId)}`, { apiKey });
  return data;
}

/** DELETE /zoom/oauth/connections/{zoom_user_id} - response is { message }. */
export async function deleteConnection(apiKey, zoomUserId) {
  const { data } = await request(`/zoom/oauth/connections/${encodeURIComponent(zoomUserId)}`, {
    apiKey,
    method: 'DELETE'
  });
  return data;
}
