/**
 * Webhook receiver for bot lifecycle and participant events.
 *
 * Two routes, because MeetStream delivers these on two different channels:
 *
 *   POST /webhook       <- `callback_url` on create_bot. Bot lifecycle:
 *                          bot.joining, bot.in_waiting_room, bot.inmeeting,
 *                          bot.recording, bot.leaving, bot.stopped, and the
 *                          post-call events. Envelope key is `event`.
 *
 *   POST /participants  <- `recording_config.realtime_endpoints[].url`.
 *                          participant_events.join / .leave, which use a
 *                          nested envelope with no top-level bot_id.
 *
 * Both are registered on the same public base URL. Always answer 200 quickly:
 * a slow or failing webhook handler is the usual reason events look "missing".
 */

import express from 'express';

const TERMINAL_EVENTS = new Set(['bot.stopped']);

/**
 * @param {object} opts
 * @param {import('./tracker.js').AttendanceTracker} opts.tracker
 * @param {number} opts.port
 * @param {(reason: string) => void} opts.onMeetingEnded
 * @returns {Promise<{ server: import('node:http').Server, close: () => Promise<void> }>}
 */
export function startWebhookServer({ tracker, port, onMeetingEnded }) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.post('/webhook', (req, res) => {
    res.status(200).json({ received: true });

    const payload = req.body || {};
    const applied = tracker.applyBotEvent(payload);
    if (!applied) {
      console.log(`  [webhook] ignored body without an "event" key`);
      return;
    }

    const suffix = applied.status ? ` (${applied.status})` : '';
    console.log(`  [lifecycle] ${applied.event}${suffix}`);

    if (applied.event === 'bot.error') {
      // Non-terminal: a streaming provider hiccuped, the bot keeps running.
      console.log(`  [lifecycle] non-fatal bot error: ${payload.message ?? 'no message'}`);
      return;
    }

    if (TERMINAL_EVENTS.has(applied.event)) {
      onMeetingEnded(`${applied.event} (${applied.status ?? 'unknown'})`);
    }
  });

  app.post('/participants', (req, res) => {
    res.status(200).json({ received: true });

    const payload = req.body || {};
    const applied = tracker.applyParticipantEvent(payload);
    if (!applied) {
      console.log('  [participants] ignored payload with no data.data.participant');
      return;
    }
    const verb = applied.action === 'join' ? 'joined' : 'left';
    console.log(`  [participants] ${applied.name} ${verb}`);
  });

  // A single catch-all so nothing is silently dropped during development.
  app.post('*', (req, res) => {
    res.status(200).json({ received: true });
    console.log(`  [webhook] unrouted POST ${req.path}`);
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      resolve({
        server,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
    server.on('error', reject);
  });
}
