// The mint endpoints MeetStream's bot calls at join time.
//
//   GET|POST /zoom/zak?user_id=alice&auth=SECRET
//   GET|POST /zoom/obf?user_id=alice&auth=SECRET      (MeetStream appends &meeting_number=...)
//
// What arrives from MeetStream:
//   - GET first. If this server answers 405, or the body cannot be parsed as a
//     token, the bot retries as POST with a JSON body. A 400 on GET is final.
//   - Headers: X-Bot-Id always, X-Webhook-Secret if the bot has one.
//   - ZAK POST body: { bot_id, webhook_secret? }
//   - OBF GET query adds meeting_number; OBF POST body: { bot_id, meeting_number, webhook_secret? }
//
// What goes back:
//   - 200, Content-Type: text/plain, the raw token and nothing else.
//   - Any non-2xx is a failure. With a token URL set, the bot does NOT fall
//     back to a guest join, so an error here means no bot in the meeting.

import { firstValue, safeEqual, USER_ID_PATTERN } from './auth.js';
import { mintUserToken, refreshAccessToken, ZoomError } from './zoom.js';

// Refresh a little before Zoom's stated expiry so a token never dies mid-request.
const EXPIRY_SKEW_MS = 60_000;
// MeetStream treats a text/plain body as a token only when it is longer than this.
const MIN_TOKEN_LENGTH = 50;

export function createMinter(config, store) {
  /** userId -> { accessToken, expiresAt } kept in memory only. */
  const accessTokens = new Map();
  /** userId -> in-flight refresh promise, so parallel joins share one refresh. */
  const refreshing = new Map();

  function remember(userId, tokenResponse) {
    const lifetimeMs = Number(tokenResponse.expires_in || 3600) * 1000;
    accessTokens.set(userId, {
      accessToken: tokenResponse.access_token,
      expiresAt: Date.now() + lifetimeMs - EXPIRY_SKEW_MS
    });
  }

  async function refresh(userId) {
    if (refreshing.has(userId)) return refreshing.get(userId);

    const task = (async () => {
      const record = await store.get(userId);
      if (!record?.refresh_token) {
        throw new ZoomError(404, `No Zoom connection stored for user_id=${userId}.`);
      }
      const tokens = await refreshAccessToken(config, record.refresh_token);
      // Zoom rotates refresh tokens. If the new one is not saved, the next
      // refresh fails with invalid_grant and the user has to reconnect.
      if (tokens.refresh_token && tokens.refresh_token !== record.refresh_token) {
        await store.save(userId, { refresh_token: tokens.refresh_token, scope: tokens.scope ?? record.scope });
      }
      remember(userId, tokens);
      return tokens.access_token;
    })();

    refreshing.set(userId, task);
    try {
      return await task;
    } finally {
      refreshing.delete(userId);
    }
  }

  async function accessTokenFor(userId) {
    const cached = accessTokens.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.accessToken;
    return refresh(userId);
  }

  /**
   * Mint one ZAK or OBF. If Zoom answers 401 the cached access token has
   * expired: refresh it ONCE and send the request again with the new token.
   * That is a credential refresh, not a retry of the failed request; any other
   * 4xx from Zoom (400/403/404) is final and reported to the bot as 502.
   */
  async function mint(userId, mode, meetingNumber) {
    const accessToken = await accessTokenFor(userId);
    try {
      return await mintUserToken(accessToken, mode, meetingNumber);
    } catch (error) {
      if (!(error instanceof ZoomError) || error.status !== 401) throw error;
      accessTokens.delete(userId);
      return mintUserToken(await refresh(userId), mode, meetingNumber);
    }
  }

  function handler(mode) {
    // Express 4 does not catch rejected promises from async handlers, so any
    // unexpected throw (for example an unreadable token store) is caught here.
    return (req, res) =>
      handle(mode, req, res).catch((error) => {
        console.error(`[mint] ${mode} unexpected error: ${error.message}`);
        if (!res.headersSent) res.status(500).type('text/plain').send('Internal error while minting the token.');
      });
  }

  async function handle(mode, req, res) {
    res.set('Cache-Control', 'no-store');
    // Only used for log lines, so keep it short and single-line.
    const rawBotId = req.get('X-Bot-Id') || (typeof req.body?.bot_id === 'string' ? req.body.bot_id : '-');
    const botId = rawBotId.replace(/[^\w.:-]/g, '').slice(0, 64) || '-';
    const fail = (status, message) => {
      console.log(`[mint] ${mode} bot=${botId} -> ${status} ${message}`);
      res.status(status).type('text/plain').send(message);
    };

    // 1. The URL is a credential. Check it before touching anything else.
    if (!safeEqual(firstValue(req.query.auth).value, config.mintSecret)) {
      return fail(401, 'unauthorized');
    }

    // 2. Which of your users to mint for. This comes from the URL you gave
    //    create_bot, never from anything the caller could choose freely.
    const userId = firstValue(req.query.user_id).value;
    if (!userId || !USER_ID_PATTERN.test(userId)) {
      return fail(400, 'Missing or invalid user_id query parameter.');
    }

    // 3. OBF needs the meeting. MeetStream appends it to the query on GET
    //    and puts it in the JSON body on POST.
    let meetingNumber;
    if (mode === 'obf') {
      const fromQuery = firstValue(req.query.meeting_number);
      if (fromQuery.count > 1) {
        console.warn(
          `[mint] obf bot=${botId} got meeting_number ${fromQuery.count} times, using the first. ` +
            'Remove meeting_number from the obf_url you pass to create_bot: MeetStream appends it.'
        );
      }
      const raw = fromQuery.value ?? (req.body?.meeting_number != null ? String(req.body.meeting_number) : undefined);
      meetingNumber = raw?.replace(/\s+/g, '');
      if (!meetingNumber || !/^\d+$/.test(meetingNumber)) {
        return fail(400, 'OBF needs a numeric meeting_number (query on GET, JSON body on POST).');
      }
    }

    const record = await store.get(userId);
    if (!record?.refresh_token) {
      return fail(
        404,
        `No Zoom connection stored for user_id=${userId}. ` +
          `Have that user open ${config.publicBaseUrl}/zoom/connect?user_id=${encodeURIComponent(userId)}&auth=<MINT_SHARED_SECRET> first.`
      );
    }

    try {
      const token = await mint(userId, mode, meetingNumber);
      if (token.length <= MIN_TOKEN_LENGTH) {
        return fail(502, `Zoom returned a ${mode.toUpperCase()} of ${token.length} characters, too short to be a real token.`);
      }
      console.log(
        `[mint] ${mode} bot=${botId} user=${userId}${meetingNumber ? ` meeting=${meetingNumber}` : ''} -> 200`
      );
      return res.status(200).type('text/plain').send(token);
    } catch (error) {
      if (error instanceof ZoomError && error.reconnect) {
        return fail(
          409,
          `The Zoom grant for user_id=${userId} is no longer valid (${error.message}). ` +
            'The user has to go through /zoom/connect again.'
        );
      }
      if (error instanceof ZoomError) return fail(502, error.message);
      throw error;
    }
  }

  return { handler, remember };
}
