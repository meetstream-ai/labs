import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Durable bot records in a JSON file.
 *
 * Small on purpose. Swap it for your database by keeping the same four methods
 * (get, upsert, all, save). What matters is the two properties this gives you:
 *
 *   1. State survives a restart. A webhook receiver that keeps state only in
 *      memory forgets every in-flight bot on deploy, and then the stuck-bot
 *      monitor has nothing to reason about.
 *   2. Writes are atomic. Write to a temp file and rename, so a crash halfway
 *      through cannot leave a truncated JSON file that fails to parse on boot.
 */
export class BotStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.tmpPath = `${filePath}.tmp`;
    /** @type {Map<string, object>} */
    this.records = new Map();
    this.dirty = false;
    this.#load();
  }

  #load() {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
      for (const record of raw.bots ?? []) this.records.set(record.botId, record);
    } catch (err) {
      // A corrupt file must not take the process down. Start clean and say so.
      console.warn(`[store] could not parse ${this.filePath}, starting empty: ${err.message}`);
    }
  }

  /** Create a record if absent. Returns the record either way. */
  upsert(botId, defaults = {}) {
    if (!this.records.has(botId)) {
      const now = new Date().toISOString();
      this.records.set(botId, {
        botId,
        state: 'created',
        createdAt: now,
        enteredStateAt: now,
        lastEventAt: null,
        finishedAt: null,
        outcome: null,
        // Webhooks never say which transcription provider was used, and that
        // determines where the lifecycle ends. Stamp it into custom_attributes
        // at create_bot time and read it back. Defaults to post-call.
        streamingOnly: false,
        stopReason: null,
        stopMessage: null,
        assets: { audio: 'pending', video: 'pending', transcript: 'pending' },
        failures: [],
        nonTerminalErrors: [],
        history: [],
        meta: {},
        ...defaults,
      });
      this.dirty = true;
    }
    return this.records.get(botId);
  }

  get(botId) {
    return this.records.get(botId) ?? null;
  }

  all() {
    return [...this.records.values()];
  }

  /** Bots that have not reached a terminal state. */
  open() {
    return this.all().filter((r) => !r.finishedAt);
  }

  touch() {
    this.dirty = true;
  }

  /** Atomic write. No-op unless something changed. */
  save({ force = false } = {}) {
    if (!this.dirty && !force) return false;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const payload = JSON.stringify(
      { updatedAt: new Date().toISOString(), bots: this.all() },
      null,
      2,
    );
    writeFileSync(this.tmpPath, payload, 'utf8');
    renameSync(this.tmpPath, this.filePath);
    this.dirty = false;
    return true;
  }

  /** Persist at most every `intervalMs`, plus one final flush on exit. */
  autoSave(intervalMs = 2000) {
    const timer = setInterval(() => this.save(), intervalMs);
    timer.unref();
    const flush = () => this.save({ force: true });
    process.once('exit', flush);
    return () => {
      clearInterval(timer);
      flush();
    };
  }
}
