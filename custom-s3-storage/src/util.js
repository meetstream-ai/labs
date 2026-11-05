/**
 * Small shared helpers: env parsing, sleeping/backoff, filename hygiene.
 */

/**
 * Read a required environment variable, failing fast with a clear message.
 * @param {string} name
 * @returns {string}
 */
export function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `Missing required environment variable "${name}". Copy .env.example to .env and fill it in.`
    );
  }
  return value.trim();
}

/**
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string|undefined}
 */
export function optionalEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return fallback;
  return value.trim();
}

/**
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
export function envInt(name, fallback) {
  const raw = optionalEnv(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable "${name}" must be a number (got "${raw}").`);
  }
  return parsed;
}

/**
 * @param {string} name
 * @param {boolean} fallback
 * @returns {boolean}
 */
export function envBool(name, fallback) {
  const raw = optionalEnv(name);
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw.toLowerCase());
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with jitter, capped at 30s.
 * @param {number} attempt - 0-indexed
 * @param {number} baseDelayMs
 * @returns {number}
 */
export function backoffDelay(attempt, baseDelayMs) {
  return Math.min(baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs, 30_000);
}

/**
 * An interruptible sleep. `wait(ms)` resolves after the timeout, or earlier if
 * something calls `wake()` (e.g. a webhook arriving while we're between polls).
 */
export function createWaiter() {
  let pending = null;

  return {
    wake() {
      if (pending) {
        const { resolve, timer } = pending;
        pending = null;
        clearTimeout(timer);
        resolve();
      }
    },
    wait(ms) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending = null;
          resolve();
        }, ms);
        pending = { resolve, timer };
      });
    },
  };
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
