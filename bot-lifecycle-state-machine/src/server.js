import express from 'express';
import { applyEvent, summarizeOutcome, STATES } from './machine.js';
import { inspect, report } from './monitor.js';
import { log } from './logger.js';

/**
 * Webhook receiver that drives the state machine.
 *
 * The envelope key is `event`, not `bot_event`.
 */
export function createServer({ store, webhookPath = '/webhook', defaultStreamingOnly = false } = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  /** Guards against processing the same delivery twice. */
  const seen = new Set();

  app.get('/health', (_req, res) =>
    res.json({ ok: true, bots: store.all().length, open: store.open().length }),
  );

  app.get('/bots', (_req, res) => res.json(report(store)));

  app.get('/bots/:botId', (req, res) => {
    const record = store.get(req.params.botId);
    if (!record) return res.status(404).json({ message: 'unknown bot_id' });
    res.json({ ...record, health: inspect(record), outcome: summarizeOutcome(record) });
  });

  app.get('/states', (_req, res) => res.json(STATES));

  app.post(webhookPath, (req, res) => {
    const body = req.body ?? {};
    const event = body.event;
    const botId = body.bot_id;

    if (!event || !botId) {
      log.error('rejected delivery: envelope needs both `event` and `bot_id`');
      return res.status(400).json({ message: 'Envelope must contain `event` and `bot_id`.' });
    }

    // At-least-once delivery. Do the work once; ACK duplicates with 200 so the
    // sender stops retrying.
    const key = `${botId}:${event}:${body.status_code ?? ''}:${body.bot_status ?? ''}`;
    if (event !== 'bot.error' && seen.has(key)) {
      log.warn(`duplicate delivery ${key}, ignored`);
      return res.status(200).json({ ok: true, duplicate: true });
    }
    seen.add(key);

    // The provider mode decides where the lifecycle ends, and no webhook
    // carries it. Stamp it into custom_attributes at create_bot time.
    const stamped = body.custom_attributes?.streaming_only;
    const record = store.upsert(botId, {
      streamingOnly: stamped === 'true' ? true : stamped === 'false' ? false : defaultStreamingOnly,
    });
    if (stamped === 'true') record.streamingOnly = true;
    if (stamped === 'false') record.streamingOnly = false;

    const transition = applyEvent(record, {
      event,
      botId,
      botStatus: body.bot_status ?? null,
      statusCode: typeof body.status_code === 'number' ? body.status_code : null,
      message: body.message ?? '',
    });
    store.touch();

    if (transition.moved) {
      log.event(event, botId, `${transition.from} -> ${transition.to}`);
      log.detail('meaning', transition.note);
    } else {
      log.event(event, botId, `[${record.state}] ${transition.note}`);
    }

    if (STATES[record.state].terminal) {
      const outcome = summarizeOutcome(record);
      log.banner(`Bot ${botId} reached a terminal state: ${outcome.state}`);
      log.detail('outcome', outcome.outcome);
      log.detail('why', outcome.label);
      if (outcome.stopReason) log.detail('bot_status at stop', outcome.stopReason);
      log.detail(
        'assets',
        `audio=${outcome.assets.audio} video=${outcome.assets.video} transcript=${outcome.assets.transcript}`,
      );
      if (outcome.nonTerminalErrors) {
        log.detail('bot.error count', `${outcome.nonTerminalErrors} (non-terminal, bot kept running)`);
      }
      if (outcome.failures.length) {
        log.detail('failures', outcome.failures.map((f) => `${f.kind}: ${f.message}`).join(' | '));
      }
      log.detail('path', record.streamingOnly ? 'streaming-only' : 'post-call');
      console.log('');
      store.save({ force: true });
    }

    res.status(200).json({ ok: true, state: record.state, moved: transition.moved });
  });

  app.use((req, res) => {
    log.warn(`unrouted ${req.method} ${req.originalUrl} (expected ${webhookPath})`);
    res.status(404).json({ message: `Not found. Webhook path is ${webhookPath}` });
  });

  return { app, seen };
}
