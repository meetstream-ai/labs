// The Zoom side: the one-time OAuth grant, access-token refresh, and the
// user-token API that produces a ZAK or an OBF token.
//
//   authorize   https://zoom.us/oauth/authorize?response_type=code&client_id=&redirect_uri=&state=
//   exchange    POST https://zoom.us/oauth/token   grant_type=authorization_code
//   refresh     POST https://zoom.us/oauth/token   grant_type=refresh_token
//   ZAK         GET  https://api.zoom.us/v2/users/me/token?type=zak                      (scope user:read:zak)
//   OBF         GET  https://api.zoom.us/v2/users/me/token?type=onbehalf&meeting_id=ID   (scope user:read:token)
//
// Nothing in this file logs a token. Error messages carry Zoom's error text only.

const ZOOM_AUTHORIZE_URL = 'https://zoom.us/oauth/authorize';
const ZOOM_TOKEN_URL = 'https://zoom.us/oauth/token';
const ZOOM_API_BASE = 'https://api.zoom.us/v2';

export class ZoomError extends Error {
  constructor(status, message, { reconnect = false } = {}) {
    super(message);
    this.name = 'ZoomError';
    this.status = status;
    // True when the stored grant is dead and the user has to run /zoom/connect again.
    this.reconnect = reconnect;
  }
}

export function buildAuthorizeUrl({ clientId, redirectUri, state }) {
  const url = new URL(ZOOM_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

function zoomErrorText(data) {
  return data?.reason || data?.error_description || data?.message || data?.error || data?.raw || 'no error body';
}

async function postToken(config, params) {
  const basic = Buffer.from(`${config.zoomClientId}:${config.zoomClientSecret}`).toString('base64');
  let response;
  try {
    response = await fetch(ZOOM_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: new URLSearchParams(params)
    });
  } catch (cause) {
    throw new ZoomError(502, `Could not reach zoom.us: ${cause.message}`);
  }

  const data = await readJson(response);
  if (!response.ok) {
    // invalid_grant / invalid refresh token means the user revoked the app,
    // the token expired unused (90 days), or it was already rotated.
    const reconnect = params.grant_type === 'refresh_token' && (response.status === 400 || response.status === 401);
    throw new ZoomError(response.status, `Zoom token endpoint returned ${response.status}: ${zoomErrorText(data)}`, {
      reconnect
    });
  }
  if (!data.access_token) {
    throw new ZoomError(502, 'Zoom token endpoint returned 200 without an access_token.');
  }
  return data;
}

/** Trade the one-time `code` from the OAuth callback for access + refresh tokens. */
export function exchangeCode(config, code) {
  return postToken(config, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri
  });
}

/** Get a fresh access token. Zoom rotates refresh tokens: persist the new one if returned. */
export function refreshAccessToken(config, refreshToken) {
  return postToken(config, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

/**
 * Call Zoom's user-token API.
 *
 * @param {string} accessToken
 * @param {'zak'|'obf'} mode
 * @param {string} [meetingId] required for obf
 * @returns {Promise<string>} the ZAK or OBF token
 */
export async function mintUserToken(accessToken, mode, meetingId) {
  const url = new URL(`${ZOOM_API_BASE}/users/me/token`);
  if (mode === 'zak') {
    url.searchParams.set('type', 'zak');
  } else {
    url.searchParams.set('type', 'onbehalf');
    url.searchParams.set('meeting_id', meetingId);
  }

  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    });
  } catch (cause) {
    throw new ZoomError(502, `Could not reach api.zoom.us: ${cause.message}`);
  }

  const data = await readJson(response);
  if (!response.ok) {
    const scope = mode === 'zak' ? 'user:read:zak' : 'user:read:token';
    const hint =
      response.status === 401 || response.status === 403
        ? ` Check the Zoom app has scope ${scope}${mode === 'obf' ? ' and Meeting SDK enabled' : ''}, then reconnect the user.`
        : '';
    throw new ZoomError(response.status, `Zoom ${mode.toUpperCase()} mint returned ${response.status}: ${zoomErrorText(data)}.${hint}`);
  }
  if (typeof data.token !== 'string' || data.token.length === 0) {
    throw new ZoomError(502, `Zoom ${mode.toUpperCase()} mint returned 200 without a token.`);
  }
  return data.token;
}
