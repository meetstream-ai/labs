import type { WebhookEvent } from './events.js';

/**
 * In-memory dedupe with a bounded window. Fine for a single-process CLI tool;
 * swap for Redis if you ever run more than one instance.
 */
export class Deduplicator {
  readonly #seen = new Set<string>();
  readonly #order: string[] = [];

  constructor(private readonly maxEntries = 1000) {}

  /** Returns true the first time a key is seen, false for repeats. */
  claim(key: string): boolean {
    if (this.#seen.has(key)) return false;
    this.#seen.add(key);
    this.#order.push(key);
    while (this.#order.length > this.maxEntries) {
      const oldest = this.#order.shift();
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
    return true;
  }
}

export function dedupeKey(event: WebhookEvent): string {
  return [event.bot_id ?? '', event.event ?? '', event.bot_event ?? '', event.timestamp ?? ''].join(
    ':',
  );
}
