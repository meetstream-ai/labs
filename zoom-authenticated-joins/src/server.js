// The token server: one-time Zoom OAuth per user, plus the mint endpoints.
//
//   GET      /zoom/connect?user_id=alice&auth=SECRET   send the user to Zoom's consent screen
//   GET      /zoom/callback?code=&state=               Zoom sends them back here
//   GET|POST /zoom/zak?user_id=alice&auth=SECRET       mint a ZAK      (called by MeetStream)
//   GET|POST /zoom/obf?user_id=alice&auth=SECRET       mint an OBF     (called by MeetStream)
//   GET      /healthz

import { randomBytes } from 'node:crypto';
import express from 'express';

import { firstValue, safeEqual, USER_ID_PATTERN } from './auth.js';
import { createMinter } from './mint.js';
import { createTokenStore } from './token-store.js';
import { buildAuthorizeUrl, exchangeCode, ZoomError } from './zoom.js';

const STATE_TTL_MS = 10 * 60 * 1000;
const NEEDED_SCOPES = ['user:read:zak', 'user:read:token'];

const page = (title, body) => `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 36rem; margin: 4rem auto; line-height: 1.5;">
    <h1 style="font-size: 1.25rem;">${escapeHtml(title)}</h1>
    ${body}
  </body>
</html>`;

export function createApp(config) {
  const store = createTokenStore(config.dataDir);
  const minter = createMinter(config, store);
  /** state -> { userId, expiresAt }. In memory: a restart just means "click connect again". */
  const pendingStates = new Map();

  const app = express();
  app.disable('x-powered-by');

  // Express answers HEAD with the GET handler. A HEAD must never mint a token.
  app.use((req, res, next) => {
    if (req.method === 'HEAD' && /^\/zoom\/(zak|obf)\/?$/.test(req.path)) {
      return res.set('Allow', 'GET, POST').status(405).end();
    }
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Step 1 (once per Zoom user): redirect to Zoom's consent screen.
  //
  // In your product this route sits behind your own login and user_id comes
  // from the session. Here it takes user_id from the query, so it is guarded
  // by the same shared secret as the mint endpoints: otherwise anyone who
  // finds your tunnel URL could attach their Zoom account to "alice".
  app.get('/zoom/connect', (req, res) => {
    if (!safeEqual(firstValue(req.query.auth).value, config.mintSecret)) {
      return res.status(401).type('text/plain').send('unauthorized');
    }
    const userId = firstValue(req.query.user_id).value;
    if (!userId || !USER_ID_PATTERN.test(userId)) {
      return res.status(400).type('text/plain').send('Pass ?user_id=<your id for this user> (letters, digits, . _ @ -).');
    }

    const now = Date.now();
    for (const [key, entry] of pendingStates) if (entry.expiresAt < now) pendingStates.delete(key);

    const state = randomBytes(24).toString('base64url');
    pendingStates.set(state, { userId, expiresAt: now + STATE_TTL_MS });
    console.log(`[oauth] connect user=${userId} -> redirecting to Zoom`);
    res.redirect(
      302,
      buildAuthorizeUrl({ clientId: config.zoomClientId, redirectUri: config.redirectUri, state })
    );
  });

  // Step 2: Zoom redirects back with ?code=&state= (or ?error=).
  app.get(config.redirectPath, async (req, res) => {
    const error = firstValue(req.query.error).value;
    if (error) {
      const detail = firstValue(req.query.error_description).value || error;
      console.log(`[oauth] callback error from Zoom: ${detail}`);
      return res.status(400).send(page('Zoom did not connect', `<p>${escapeHtml(detail)}</p>`));
    }

    const state = firstValue(req.query.state).value;
    const code = firstValue(req.query.code).value;
    const pending = state ? pendingStates.get(state) : undefined;
    if (state) pendingStates.delete(state); // single use
    if (!pending || pending.expiresAt < Date.now()) {
      return res
        .status(400)
        .send(page('Link expired', '<p>This callback does not match a recent connect request. Start again from /zoom/connect.</p>'));
    }
    if (!code) {
      return res.status(400).send(page('Missing code', '<p>Zoom did not include a <code>code</code> parameter.</p>'));
    }

    try {
      const tokens = await exchangeCode(config, code);
      if (!tokens.refresh_token) {
        throw new ZoomError(502, 'Zoom returned no refresh_token, so this connection could not be reused later.');
      }
      await store.save(pending.userId, {
        refresh_token: tokens.refresh_token,
        scope: tokens.scope || '',
        connected_at: new Date().toISOString()
      });
      minter.remember(pending.userId, tokens);

      const granted = String(tokens.scope || '').split(/[\s,]+/).filter(Boolean);
      const missing = granted.length > 0 ? NEEDED_SCOPES.filter((s) => !granted.includes(s)) : [];
      console.log(`[oauth] connected user=${pending.userId} scopes=${granted.join(' ') || '(not reported)'}`);
      if (missing.length > 0) console.warn(`[oauth] user=${pending.userId} is missing scope(s): ${missing.join(', ')}`);

      return res.send(
        page(
          'Zoom connected',
          `<p>Stored a Zoom grant for <code>${escapeHtml(pending.userId)}</code>. MeetStream bots can now join as this user (ZAK) or on their behalf (OBF).</p>` +
            (missing.length > 0
              ? `<p><strong>Missing scope(s):</strong> ${missing.map(escapeHtml).join(', ')}. Add them to the Zoom app and connect again, or that mode will fail.</p>`
              : '') +
            '<p style="color:#666;">You can close this tab.</p>'
        )
      );
    } catch (err) {
      console.error(`[oauth] code exchange failed for user=${pending.userId}: ${err.message}`);
      return res
        .status(502)
        .send(page('Zoom connection failed', `<p>${escapeHtml(err.message)}</p><p>Codes are single-use. Start again from /zoom/connect.</p>`));
    }
  });

  // Step 3 (every join): the mint endpoints.
  const json = express.json({ limit: '16kb' });
  for (const mode of ['zak', 'obf']) {
    app
      .route(`/zoom/${mode}`)
      .get(json, minter.handler(mode))
      .post(json, minter.handler(mode))
      .all((_req, res) => res.set('Allow', 'GET, POST').status(405).type('text/plain').send('method not allowed'));
  }

  return app;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
