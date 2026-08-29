import express from 'express';

/**
 * A throwaway local HTTP server that catches Zoom's redirect.
 *
 * Zoom sends the end user's browser to your registered redirect URL with
 * either:
 *
 *   ?code=<authorization code>&state=<whatever you passed>
 *   ?error=access_denied&error_description=<why>
 *
 * This server listens on one path, validates `state`, and hands the code back
 * to the CLI. In a real product this is a route inside your own web app, not a
 * process that exits after one callback.
 */

const DONE_PAGE = (title, detail) => `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; line-height: 1.5;">
    <h1 style="font-size: 1.25rem;">${title}</h1>
    <p>${detail}</p>
    <p style="color:#666;">You can close this tab and return to your terminal.</p>
  </body>
</html>`;

/**
 * Start the callback listener.
 *
 * @param {object} params
 * @param {number} params.port           local port to bind
 * @param {string} params.pathname       path of the redirect URI, e.g. "/zoom/callback"
 * @param {string} [params.expectedState] reject callbacks whose state does not match
 * @returns {Promise<{ waitForCode(timeoutMs: number): Promise<{code: string, state: string|undefined}>, close(): Promise<void> }>}
 */
export async function startCallbackServer({ port, pathname, expectedState }) {
  const app = express();
  const route = pathname && pathname !== '' ? pathname : '/';

  /** @type {{resolve: Function, reject: Function}|null} */
  let pending = null;
  /** @type {{code: string, state: string|undefined}|null} */
  let received = null;
  /** @type {Error|null} */
  let failure = null;

  const settle = (err, value) => {
    if (err) failure = err;
    else received = value;
    if (pending) {
      const { resolve, reject } = pending;
      pending = null;
      if (err) reject(err);
      else resolve(value);
    }
  };

  app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

  app.get(route, (req, res) => {
    const { code, state, error, error_description: errorDescription } = req.query;

    if (error) {
      const detail = String(errorDescription || error);
      res.status(400).send(DONE_PAGE('Zoom returned an error', escapeHtml(detail)));
      settle(new Error(`Zoom refused the authorization: ${detail}`));
      return;
    }

    if (!code) {
      res.status(400).send(DONE_PAGE('Missing code', 'Zoom did not include a ?code= parameter.'));
      return;
    }

    // The state check is the CSRF guard. A mismatch means this callback did not
    // come from the authorize URL we generated, so it is not answered.
    if (expectedState && state !== expectedState) {
      res
        .status(400)
        .send(DONE_PAGE('State mismatch', 'This callback did not originate from the request we started.'));
      return;
    }

    res.status(200).send(
      DONE_PAGE('Zoom account connected', 'The authorization code was received and is being exchanged.')
    );
    settle(null, { code: String(code), state: state === undefined ? undefined : String(state) });
  });

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(port);
    s.once('listening', () => resolve(s));
    s.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use. Free it or pass --port <other port>.`));
      } else {
        reject(err);
      }
    });
  });

  return {
    /**
     * Resolve once the callback arrives, or reject on timeout / Zoom error.
     * @param {number} timeoutMs
     */
    waitForCode(timeoutMs) {
      if (failure) return Promise.reject(failure);
      if (received) return Promise.resolve(received);

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending = null;
          reject(
            new Error(
              `No callback arrived within ${Math.round(timeoutMs / 1000)}s. ` +
                'Check that the redirect URL registered on your Zoom app points at this listener.'
            )
          );
        }, timeoutMs);

        pending = {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          }
        };
      });
    },

    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
