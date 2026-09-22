import express from 'express';
import { parseEnvelope } from './events.js';
import { DeliveryLog, deliveryKey } from './dedupe.js';
import { dispatch, ensureState } from './handlers.js';
import { log } from './logger.js';

/**
 * The webhook receiver.
 *
 * Contract with MeetStream:
 *   - ACK fast. Return 2xx as soon as the delivery is recorded. MeetStream does
 *     not retry a failed or timed-out delivery, so a slow handler risks losing
 *     the event outright.
 *   - ACK duplicates with 200 too. Duplicates come from your own
 *     infrastructure (tunnel or proxy replays, queue re-drives), not from
 *     MeetStream, and the dedupe layer makes them a no-op.
 *   - A non-2xx does not trigger a redelivery. Return one only to make the
 *     failure visible in logs; the raw body is what you replay from.
 */
export function createServer({ webhookPath = '/webhook', streamingOnly = false } = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  /** botId -> per-bot state built up from events */
  const bots = new Map();
  const deliveries = new DeliveryLog();
  const stats = { received: 0, duplicates: 0, handled: 0, rejected: 0, unknown: 0 };

  app.get('/health', (_req, res) => {
    res.json({ ok: true, bots: bots.size, deliveries: deliveries.size, stats });
  });

  /** Inspect what the handler has learned about a bot. Handy while developing. */
  app.get('/bots/:botId', (req, res) => {
    const state = bots.get(req.params.botId);
    if (!state) return res.status(404).json({ message: 'No events seen for that bot_id yet.' });
    res.json(state);
  });

  app.get('/bots', (_req, res) => res.json([...bots.values()]));

  app.post(webhookPath, (req, res) => {
    stats.received += 1;

    const env = parseEnvelope(req.body);
    if (!env.valid) {
      stats.rejected += 1;
      log.error(`rejected delivery: ${env.reason}`);
      // 400 tells the sender the payload itself is wrong. Redelivering an
      // identical malformed body will not help, so do not ask for a retry.
      return res.status(400).json({ message: env.reason });
    }

    const key = deliveryKey({
      botId: env.botId,
      event: env.botEvent,
      timestamp: env.timestamp,
      message: env.message,
    });

    // ---- Idempotency gate -------------------------------------------------
    if (!deliveries.claim(key)) {
      stats.duplicates += 1;
      log.warn(`duplicate delivery ${key} ignored (already processed)`);
      // 200, not 409. A duplicate is a successful no-op from the sender's view.
      return res.status(200).json({ ok: true, duplicate: true });
    }

    const state = ensureState(bots, env.botId);

    // Webhooks never tell you which transcription provider the bot used, and
    // that determines whether a post-call transcript will ever exist (bot.done
    // ends the stream either way). The reliable trick is to stamp
    // it into custom_attributes at create_bot time (values must be strings) and
    // read it back here. Falls back to the server-wide default.
    const expectStreamingOnly =
      env.customAttributes?.streaming_only === 'true'
        ? true
        : env.customAttributes?.streaming_only === 'false'
          ? false
          : streamingOnly;
    state.streamingOnly = expectStreamingOnly;

    let result;
    try {
      result = dispatch(env, { state, raw: req.body, expectStreamingOnly });
    } catch (err) {
      // The handler blew up. Roll the dedupe claim back so a replay of this
      // body (from your own queue or logs; MeetStream will not resend it) can
      // retry the work, and log the raw body so there is something to replay.
      deliveries.seen.delete(key);
      log.error(`handler threw for ${env.event}/${env.botId}: ${err.message}`);
      log.error(`raw body for replay: ${JSON.stringify(req.body)}`);
      return res.status(500).json({ message: 'Handler error. MeetStream does not redeliver; replay from logs.' });
    }

    if (result.handled) stats.handled += 1;
    else stats.unknown += 1;

    if (state.finished) {
      printSummary(state, expectStreamingOnly);
    }

    return res.status(200).json({ ok: true });
  });

  // Anything else. Useful signal when a callback_url has the wrong path.
  app.use((req, res) => {
    log.warn(`unrouted ${req.method} ${req.originalUrl} (webhook path is ${webhookPath})`);
    res.status(404).json({ message: `Not found. Webhook path is ${webhookPath}` });
  });

  return { app, bots, deliveries, stats };
}

function printSummary(state, streamingOnly) {
  log.banner(`Bot ${state.botId} finished`);
  log.detail(
    'events seen',
    state.events.map((e) => (e.botEvent && e.botEvent !== e.event ? `${e.event}(${e.botEvent})` : e.event)).join(' -> '),
  );
  log.detail('joined meeting', state.joined ? 'yes' : 'no');
  log.detail('recorded', state.recorded ? 'yes' : 'no');
  if (state.outcome) {
    log.detail('stop reason', `${state.outcome.reason} (${state.outcome.label})`);
  }
  log.detail(
    'assets',
    `audio=${state.assets.audio} video=${state.assets.video} transcript=${state.assets.transcript}`,
  );
  if (state.transcriptFailed) log.detail('transcription', 'FAILED (status_code 500)');
  if (state.errors.length) log.detail('errors', String(state.errors.length));
  log.detail('terminal via', state.deleted ? 'data_deletion' : 'bot.done');
  if (streamingOnly) log.detail('transcript', 'none (streaming-only provider, no post-call transcript)');
  console.log('');
}
