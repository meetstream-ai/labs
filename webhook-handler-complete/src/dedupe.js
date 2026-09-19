import { createHash } from 'node:crypto';

/**
 * Idempotent delivery guard.
 *
 * MeetStream can deliver the same webhook more than once (network retries,
 * at-least-once delivery). Your handler must be safe to call twice.
 *
 * Dedupe key is `bot_id + (bot_event ?? event) + timestamp`. Every delivery
 * carries an ISO 8601 `timestamp`, lifecycle events included, and a redelivery
 * repeats it, so the key separates a true duplicate from a legitimately
 * repeated event such as `bot.error`. Using `bot_event ?? event` keeps the five
 * terminal reasons (which all arrive as event `bot.stopped`) distinct.
 *
 * Fallback for a body without `timestamp`: key on `bot_id + name`, folding in a
 * hash of `message` for `bot.error`, which can repeat with different messages.
 *
 * This is an in-memory store with TTL so the example runs with zero setup.
 * In production put this in Redis (SETNX + EXPIRE) or a unique index in your
 * database, so it survives restarts and works across multiple instances.
 */

/** Events that may legitimately repeat (used only when a body has no timestamp). */
const REPEATABLE_EVENTS = new Set(['bot.error']);

export function deliveryKey({ botId, event, timestamp = null, message = '' }) {
  if (timestamp) return `${botId}:${event}:${timestamp}`;
  if (REPEATABLE_EVENTS.has(event)) {
    const digest = createHash('sha1').update(message).digest('hex').slice(0, 12);
    return `${botId}:${event}:${digest}`;
  }
  return `${botId}:${event}`;
}

export class DeliveryLog {
  /** @param {{ ttlMs?: number, maxEntries?: number }} [opts] */
  constructor({ ttlMs = 24 * 60 * 60 * 1000, maxEntries = 50_000 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    /** @type {Map<string, number>} key -> first-seen epoch ms */
    this.seen = new Map();
  }

  /**
   * Claim a delivery. Returns true the first time a key is seen, false for
   * every duplicate. Callers should ACK duplicates with 200 and do no work.
   */
  claim(key) {
    this.#sweep();
    if (this.seen.has(key)) return false;
    this.seen.set(key, Date.now());
    return true;
  }

  has(key) {
    return this.seen.has(key);
  }

  get size() {
    return this.seen.size;
  }

  #sweep() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, at] of this.seen) {
      if (at < cutoff) this.seen.delete(key);
      else break; // Map preserves insertion order, so the rest are newer.
    }
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      this.seen.delete(oldest);
    }
  }
}
