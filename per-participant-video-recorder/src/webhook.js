import express from 'express';
import logger from './logger.js';

/**
 * Event names this app acts on (see
 * https://docs.meetstream.ai/guides/webhooks/webhooks-and-events for the
 * full set). Every ending arrives as event `bot.stopped`; `bot_event` holds
 * the reason. `bot.done` is the final event on every path. Anything not
 * listed here is logged at debug level and ignored.
 */
const KNOWN_EVENTS = new Set([
  'bot.joining',
  'bot.inmeeting',
  'bot.stopped',
  'audio.processed',
  'video.processed',
  'transcription.processed',
  'data_deletion',
]);

/**
 * Builds the Express router that receives all MeetStream webhook events
 * for a single bot session. The entire lifecycle is webhook-driven - no
 * polling.
 *
 * @param {object} params
 * @param {(eventType: string, payload: object) => void} params.onEvent
 * @returns {import('express').Router}
 */
export function createWebhookRouter({ onEvent }) {
  const router = express.Router();

  // MeetStream doesn't send a delivery-id header. Every delivery carries
  // `event` (generic name), usually `bot_event` (specific name; on terminals
  // it is the reason, e.g. bot.kicked) and an ISO `timestamp`, so de-dupe on
  // {bot_id, bot_event ?? event, timestamp}.
  const seenDeliveries = new Set();

  router.post('/webhook', express.json({ limit: '5mb' }), (req, res) => {
    const body = req.body ?? {};
    const eventType = body.event ?? 'unknown';
    const deliveryKey = `${body.bot_id ?? ''}:${body.bot_event ?? eventType}:${body.timestamp ?? ''}`;

    // Acknowledge immediately; webhook deliveries are not retried, so keep
    // this handler fast and do the real work after responding.
    res.status(200).json({ received: true });

    if (deliveryKey !== '::' ) {
      if (seenDeliveries.has(deliveryKey)) {
        logger.debug(`Ignoring duplicate webhook delivery: ${deliveryKey}`);
        return;
      }
      seenDeliveries.add(deliveryKey);
    }

    if (!KNOWN_EVENTS.has(eventType)) {
      logger.debug(`Received unrecognized webhook event: ${eventType}`);
    }

    try {
      onEvent(eventType, body);
    } catch (err) {
      logger.error(`Error handling webhook event "${eventType}": ${err.message}`);
    }
  });

  return router;
}
