/**
 * Tiny dependency-free console logger.
 *
 * Set LOG_LEVEL to one of: silent, error, warn, info, debug (default: info).
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

const configured = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const threshold = LEVELS[configured] ?? LEVELS.info;

function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

function emit(label, weight, stream, message) {
  if (weight > threshold) return;
  stream.write(`${stamp()} ${label} ${message}\n`);
}

export const log = {
  error: (message) => emit('ERROR', LEVELS.error, process.stderr, message),
  warn: (message) => emit(' WARN', LEVELS.warn, process.stderr, message),
  info: (message) => emit(' INFO', LEVELS.info, process.stdout, message),
  debug: (message) => emit('DEBUG', LEVELS.debug, process.stdout, message),

  /** Write raw text (no newline, no timestamp) - used by the progress meter. */
  raw: (text) => process.stdout.write(text),

  /** True when stdout is a terminal, so progress can redraw in place. */
  isTty: Boolean(process.stdout.isTTY),
};

export default log;
