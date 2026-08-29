import express from 'express';

import { log } from './log.js';

/**
 * MeetStream posts lifecycle events to whatever `callback_url` you passed to
 * create_bot. The envelope looks like:
 *
 *   {
 *     "event": "audio.processed",     <- the key is `event`, not `bot_event`
 *     "bot_id": "...",
 *     "bot_status": "Stopped",
 *     "message": "...",
 *     "status_code": 200,
 *     "custom_attributes": {}
 *   }
 *
 * Full lifecycle:
 *   bot.joining -> bot.in_waiting_room -> bot.inmeeting -> bot.recording
 *   -> bot.leaving -> bot.stopped (terminal) -> manifest.completed
 *   -> audio.processed -> transcription.processed | transcription.failed
 *   -> video.processed -> bot.done -> data_deletion
 *
 * Note: `bot.stopped` always carries status_code 200, even when the reason was
 * NotAllowed / Denied / Error - read `bot_status` for the reason.
 */
export const KNOWN_EVENTS = new Set([
  'bot.joining',
  'bot.in_waiting_room',
  'bot.inmeeting',
  'bot.recording',
  'bot.leaving',
  'bot.stopped',
  'bot.error',
  'manifest.completed',
  'audio.processed',
  'transcription.processed',
  'transcription.failed',
  'video.processed',
  'bot.done',
  'data_deletion',
]);

/**
 * Build an Express app that receives MeetStream webhooks on POST /webhook.
 *
 * @param {object} params
 * @param {(event: string, payload: any) => void} params.onEvent
 * @param {string} [params.pathname]
 * @returns {import('express').Express}
 */
export function createWebhookApp({ onEvent, pathname = '/webhook' }) {
  const app = express();
  const seen = new Set();

  app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

  app.post(pathname, express.json({ limit: '5mb' }), (req, res) => {
    const payload = req.body ?? {};
    const event = payload.event ?? 'unknown';

    // Acknowledge first: MeetStream's delivery is best-effort and we do not
    // want slow local processing to look like a failed delivery.
    res.status(200).json({ received: true });

    const key = `${payload.bot_id ?? ''}:${event}:${payload.timestamp ?? ''}`;
    if (key !== '::') {
      if (seen.has(key)) {
        log.debug(`Duplicate webhook ignored: ${key}`);
        return;
      }
      seen.add(key);
    }

    if (!KNOWN_EVENTS.has(event)) {
      log.debug(`Unrecognized webhook event "${event}" - ignoring.`);
    }

    try {
      onEvent(event, payload);
    } catch (err) {
      log.error(`Webhook handler for "${event}" threw: ${err.message}`);
    }
  });

  return app;
}

/**
 * Start the webhook server and resolve once it is listening.
 *
 * @param {object} params
 * @param {import('express').Express} params.app
 * @param {number} params.port
 * @returns {Promise<import('node:http').Server>}
 */
export function listen({ app, port }) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port);
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}
