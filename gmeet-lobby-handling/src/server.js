/**
 * Webhook receiver.
 *
 * Two things worth knowing about MeetStream webhook delivery:
 *
 *  1. Deliveries to a per-bot `callback_url` (what this template uses) are
 *     NOT signed. Signatures apply to workspace webhook endpoints created in
 *     the dashboard. If you need authenticated deliveries, receive events on a
 *     workspace endpoint and route with `custom_attributes`.
 *
 *  2. When you do verify, the HMAC is computed over the RAW request body. That
 *     is why this server captures the raw buffer before JSON parsing - parse and
 *     re-serialize and the digest will never match.
 *
 * Signature scheme (workspace endpoints):
 *   X-MeetStream-Signature: sha256=<hex HMAC-SHA256 of raw body, keyed with the secret>
 *   X-MeetStream-Timestamp: ISO 8601 delivery time, for replay-window checks
 */

import crypto from 'node:crypto';
import express from 'express';

export function verifySignature(secret, rawBody, headers, toleranceSeconds = 300) {
  const signature = headers['x-meetstream-signature'] ?? '';
  if (!signature.startsWith('sha256=')) return false;

  const given = Buffer.from(signature.slice(7), 'hex');
  if (given.length !== 32) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  if (!crypto.timingSafeEqual(expected, given)) return false;

  const timestamp = headers['x-meetstream-timestamp'];
  if (timestamp) {
    const sent = Date.parse(timestamp);
    if (Number.isNaN(sent)) return false;
    if (Math.abs(Date.now() - sent) > toleranceSeconds * 1000) return false;
  }
  return true;
}

/**
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} [opts.path]        webhook path, default /webhook
 * @param {string} [opts.secret]      enables signature verification when set
 * @param {(payload: object) => Promise<void>|void} opts.onEvent
 * @returns {Promise<{ server: import('node:http').Server, close: () => Promise<void> }>}
 */
export function startWebhookServer({ port, path = '/webhook', secret, onEvent }) {
  const app = express();

  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.post(path, (req, res) => {
    if (secret && !verifySignature(secret, req.rawBody ?? Buffer.alloc(0), req.headers)) {
      console.error('Rejected a webhook delivery: bad or missing signature.');
      res.status(401).json({ message: 'invalid signature' });
      return;
    }

    // Acknowledge immediately. Slow handlers cause redeliveries.
    res.status(200).json({ received: true });

    Promise.resolve()
      .then(() => onEvent(req.body))
      .catch((error) => {
        console.error(`Webhook handler threw: ${error.stack ?? error.message}`);
      });
  });

  // Anything else: 404 with a hint, so a misconfigured callback_url is obvious.
  app.use((req, res) => {
    res.status(404).json({ message: `No handler for ${req.method} ${req.path}. Use POST ${path}.` });
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port);
    server.once('listening', () => {
      resolve({
        server,
        close: () =>
          new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use. Set PORT to a free port.`));
      } else {
        reject(error);
      }
    });
  });
}
