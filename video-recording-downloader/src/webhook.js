import express from 'express';

import { log } from './log.js';

/**
 * MeetStream posts lifecycle events to whatever `callback_url` you passed to
 * create_bot. The envelope looks like:
 *
 *   {
 *     "event": "bot.stopped",          <- always present: the generic name
 *     "bot_event": "bot.kicked",       <- the specific name (the reason, on terminals)
 *     "bot_id": "...",
 *     "bot_status": "Stopped",
 *     "message": "...",
 *     "status_code": 200,
 *     "timestamp": "2026-01-15T10:30:45Z",
 *     "custom_attributes": {}
 *   }
 *
 * `bot_event` equals `event` except on terminals, and a few events omit it
 * (manifest.*, bot.transcriptionready, bot.uploading, participant_events.*),
 * so read `bot_event ?? event` for the specific name.
 *
 * Typical lifecycle:
 *   bot.joining -> bot.in_waiting_room -> bot.inmeeting -> bot.recording
 *   -> bot.leaving -> bot.stopped (terminal, reason in bot_event)
 *   -> manifest.completed / audio.processed (order varies)
 *   -> [post-call transcription only: transcription.processed | transcription.failed
 *       -> bot.transcriptionready] -> video.processed -> bot.done (final, every path)
 *   -> data_deletion (only after a delete or retention expiry)
 *
 * Every ending arrives once as event `bot.stopped`. bot_event gives the reason:
 *   bot.stopped (200, clean) | bot.kicked (200) | bot.notallowed (500)
 *   | bot.denied (500) | bot.failed (usually 500)
 */
export const KNOWN_EVENTS = new Set([
  'bot.scheduled',
  'bot.joining',
  'bot.in_waiting_room',
  'bot.inmeeting',
  'bot.recording',
  'bot.leaving',
  'bot.stopped',
  'bot.error',
  'bot.uploading',
  'manifest.completed',
  'manifest.skipped',
  'audio.processed',
  'audio.skipped',
  'transcription.processed',
  'transcription.failed',
  'transcription.skipped',
  'bot.transcriptionready',
  'video.processed',
  'bot.done',
  'data_deletion',
]);

/**
 * Why a bot ended, from a `bot.stopped` payload. `bot_event` is authoritative.
 * When it is missing, fall back to `bot_status` compared case-insensitively.
 * Never branch on bot_status alone: a kick and a clean exit both say "Stopped".
 *
 * @param {any} payload
 * @returns {'bot.stopped'|'bot.kicked'|'bot.notallowed'|'bot.denied'|'bot.failed'|string}
 */
export function terminalReason(payload) {
  if (payload?.bot_event) return payload.bot_event;
  const status = String(payload?.bot_status ?? '').toLowerCase();
  if (status === 'notallowed') return 'bot.notallowed';
  if (status === 'denied') return 'bot.denied';
  if (status === 'error' || status === 'failed') return 'bot.failed';
  return 'bot.stopped';
}

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

    // Every delivery carries a timestamp, so {bot_id, bot_event ?? event,
    // timestamp} identifies a redelivery.
    if (payload.timestamp) {
      const key = `${payload.bot_id ?? payload.data?.bot?.id ?? ''}:${payload.bot_event ?? event}:${payload.timestamp}`;
      if (seen.has(key)) {
        log.debug(`Duplicate webhook ignored: ${key}`);
        return;
      }
      seen.add(key);
    }

    if (!KNOWN_EVENTS.has(event) && !String(event).startsWith('participant_events.')) {
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
