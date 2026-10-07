import express from 'express';
import { log } from './logger.js';

/**
 * A deliberately small webhook receiver.
 *
 * Its job here is not to interpret the lifecycle (see the
 * webhook-handler-complete template for that). Its job is to prove that
 * deliveries are actually arriving through your tunnel, and to show you the
 * raw body when they do.
 */
export function createServer({ webhookPath = '/webhook' } = {}) {
  const app = express();

  // Keep the raw bytes around. If you later add signature verification you
  // must hash the exact bytes that were sent, not a re-serialized object.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  /** Everything that has arrived, newest last. */
  const deliveries = [];
  /** nonce -> resolve fn, used by the self-test in verify.js */
  const waiters = new Map();

  app.get('/health', (_req, res) => res.json({ ok: true, deliveries: deliveries.length }));

  app.get('/deliveries', (_req, res) => res.json(deliveries));

  app.post(webhookPath, (req, res) => {
    const body = req.body ?? {};
    // `event` is always present (the generic name). Most deliveries also carry
    // `bot_event`, the specific name; on terminals (event "bot.stopped") it is
    // the reason: bot.stopped, bot.kicked, bot.notallowed, bot.denied, bot.failed.
    const event = body.event ?? '(missing `event` key)';
    const botEvent = body.bot_event ?? null;
    // participant_events.* nest the bot id under data.bot.id.
    const botId = body.bot_id ?? body.data?.bot?.id ?? '(no bot_id)';

    const record = {
      receivedAt: new Date().toISOString(),
      event,
      botEvent,
      botId,
      timestamp: body.timestamp ?? null,
      botStatus: body.bot_status ?? null,
      statusCode: body.status_code ?? null,
      message: body.message ?? '',
      bytes: req.rawBody?.length ?? 0,
      body,
    };
    deliveries.push(record);

    const label = botEvent && botEvent !== event ? `${event} (${botEvent})` : event;
    log.event(String(label), String(botId), record.message || `${record.bytes} bytes`);

    // Resolve the reachability self-test if this is its ping.
    const nonce = body.custom_attributes?.verify_nonce;
    if (nonce && waiters.has(nonce)) {
      waiters.get(nonce)(record);
      waiters.delete(nonce);
    }

    // ACK fast. Anything slow here causes MeetStream to redeliver.
    res.status(200).json({ ok: true });
  });

  app.use((req, res) => {
    log.warn(`unrouted ${req.method} ${req.originalUrl} (expected ${webhookPath})`);
    res.status(404).json({ message: `Not found. Webhook path is ${webhookPath}` });
  });

  /** Wait for a delivery carrying custom_attributes.verify_nonce === nonce. */
  function waitForNonce(nonce, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(nonce);
        reject(new Error(`no delivery with nonce ${nonce} within ${timeoutMs}ms`));
      }, timeoutMs);
      waiters.set(nonce, (record) => {
        clearTimeout(timer);
        resolve(record);
      });
    });
  }

  return { app, deliveries, waitForNonce };
}
