import express, { type Express, type Request, type Response } from 'express';
import type { Config } from '../config.js';
import { logger } from '../logger.js';
import { handleEvent, type PipelineOptions, type PipelineResult } from '../pipeline.js';
import { Deduplicator, dedupeKey } from './dedupe.js';
import { webhookEventSchema } from './events.js';
import { secretPathMatches, verifyWebhookSignature } from './signature.js';

/** 1 MiB is far above any real MeetStream event; it caps memory per request. */
const MAX_BODY_BYTES = 1_000_000;

export interface ServerOptions extends PipelineOptions {
  config: Config;
  /** Notified after each event finishes processing. Used by tests and the CLI. */
  onProcessed?: (result: PipelineResult) => void;
}

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

export function createServer(options: ServerOptions): Express {
  const { config } = options;
  const app = express();
  const deduplicator = new Deduplicator();

  // Capture the exact bytes before parsing: a signature covers the raw body, and
  // re-serialising the parsed object will not reproduce it.
  app.use(
    express.json({
      limit: MAX_BODY_BYTES,
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = Buffer.from(buf);
      },
    }),
  );

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Routed on a parameter, not the literal path, so the token is compared in
  // constant time rather than by Express's own string match.
  app.post('/webhook/meetstream/:token', (req: RawBodyRequest, res: Response) => {
    const raw = req.params.token;
    const token = Array.isArray(raw) ? '' : (raw ?? '');
    if (!secretPathMatches(token, config.WEBHOOK_PATH_TOKEN)) {
      // 404, not 401: a caller with the wrong token learns nothing about the route.
      logger.warn('Rejected webhook on an unknown path');
      res.status(404).json({ error: 'not found' });
      return;
    }

    if (!verifySignature(req, config)) {
      // Deliberately terse: do not tell an unauthenticated caller which check failed.
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const parsed = webhookEventSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn('Rejected malformed webhook payload');
      res.status(400).json({ error: 'invalid payload' });
      return;
    }

    const event = parsed.data;
    logger.debug('Webhook received', { payload: event });

    if (!deduplicator.claim(dedupeKey(event))) {
      logger.info('Ignoring duplicate webhook', { botId: event.bot_id, event: event.event });
      res.status(200).json({ status: 'duplicate' });
      return;
    }

    // Acknowledge first — MeetStream does not retry a non-2xx — then do the work.
    res.status(200).json({ status: 'accepted' });

    void handleEvent(event, options)
      .then((result) => options.onProcessed?.(result))
      .catch((error: unknown) => {
        logger.error('Pipeline failed', {
          botId: event.bot_id,
          event: event.event,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });

  // Any other path, including a wrong token, looks the same from outside.
  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  return app;
}

/**
 * Enforced whenever WEBHOOK_SIGNING_SECRET is configured, which is the case for
 * workspace-level endpoints. Per-bot `callback_url` deliveries are unsigned, so
 * with no secret set the secret path segment is the only guard — by design.
 */
function verifySignature(req: RawBodyRequest, config: Config): boolean {
  if (!config.WEBHOOK_SIGNING_SECRET) return true;

  const result = verifyWebhookSignature({
    rawBody: req.rawBody ?? Buffer.alloc(0),
    headers: req.headers,
    secret: config.WEBHOOK_SIGNING_SECRET,
    signatureHeader: config.WEBHOOK_SIGNATURE_HEADER,
    timestampHeader: config.WEBHOOK_TIMESTAMP_HEADER,
    toleranceSeconds: config.WEBHOOK_TOLERANCE_SECONDS,
  });

  if (!result.valid) {
    logger.warn('Rejected webhook signature', { reason: result.reason });
    return false;
  }
  return true;
}
