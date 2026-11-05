import readline from 'node:readline';

import { log } from './log.js';

/**
 * Single-keypress input for the control CLI.
 *
 * Raw mode is what makes "press p to pause" work without an Enter key. It also
 * means the terminal stops turning Ctrl+C into SIGINT for us, so that has to
 * be handled explicitly - see the `ctrl+c` branch below.
 */

/**
 * @param {object} params
 * @param {(key: string) => void|Promise<void>} params.onKey - receives a
 *   lowercase key name, or "ctrl+c"
 * @returns {{ close: () => void, available: boolean }}
 */
export function listenForKeys({ onKey }) {
  if (!process.stdin.isTTY) {
    return { close() {}, available: false };
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  /**
   * @param {string} str
   * @param {{ name?: string, ctrl?: boolean }} key
   */
  const listener = (str, key) => {
    const name = key?.ctrl && key?.name === 'c' ? 'ctrl+c' : (key?.name ?? str ?? '').toLowerCase();
    if (!name) return;
    Promise.resolve(onKey(name)).catch((err) => log.error(`Key handler failed: ${err.message}`));
  };

  process.stdin.on('keypress', listener);

  return {
    close() {
      process.stdin.off('keypress', listener);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    },
    available: true,
  };
}

/**
 * Parse a scripted sequence for non-interactive runs, e.g.
 * "30:pause,60:resume,90:stop" means pause at t+30s, resume at t+60s,
 * stop at t+90s.
 *
 * @param {string} spec
 * @returns {Array<{ atSeconds: number, action: 'pause'|'resume'|'stop' }>}
 */
export function parseSequence(spec) {
  const steps = [];
  for (const chunk of String(spec).split(',')) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const [rawSeconds, rawAction] = trimmed.split(':');
    const atSeconds = Number(rawSeconds);
    const action = String(rawAction ?? '').trim().toLowerCase();
    if (!Number.isFinite(atSeconds) || !['pause', 'resume', 'stop'].includes(action)) {
      throw new Error(
        `Invalid AUTO_SEQUENCE step "${trimmed}". Use "<seconds>:<pause|resume|stop>", ` +
          'e.g. "30:pause,60:resume,90:stop".'
      );
    }
    steps.push({ atSeconds, action: /** @type {'pause'|'resume'|'stop'} */ (action) });
  }
  steps.sort((a, b) => a.atSeconds - b.atSeconds);
  return steps;
}
