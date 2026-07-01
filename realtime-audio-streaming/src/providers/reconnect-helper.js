/**
 * reconnect-helper.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared retry/backoff logic for provider WebSocket connections.
 * Any provider can wrap its connect() call with this to get automatic
 * reconnection with exponential backoff if the upstream service drops
 * the connection mid-meeting (network blip, provider restart, etc.)
 *
 * Without this, a dropped Deepgram/AssemblyAI/OpenAI socket means audio
 * keeps flowing from MeetStream but silently goes nowhere — no error,
 * no crash, just missing transcripts for the rest of the meeting.
 */

const MAX_RECONNECT_ATTEMPTS = 6;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 15000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps a provider's raw connect logic with automatic reconnect.
 *
 * @param {object} opts
 * @param {() => Promise<WebSocket>} opts.openSocket - opens a fresh socket, resolves once "open" fires
 * @param {(ws: WebSocket) => void} opts.onOpen - wire up message handlers etc. on the fresh socket
 * @param {(reason: string) => void} opts.onReconnecting - called when a reconnect attempt starts
 * @param {(err: Error) => void} opts.onGiveUp - called if all reconnect attempts are exhausted
 * @param {import('../logger.js').Logger} opts.logger
 * @returns {{ getSocket: () => WebSocket, stop: () => void }}
 */
export function withReconnect({ openSocket, onOpen, onReconnecting, onGiveUp, logger }) {
  let current = null;
  let stopped = false;
  let attempt = 0;

  async function connectLoop() {
    while (!stopped) {
      try {
        const ws = await openSocket();
        current = ws;
        attempt = 0; // reset backoff after a successful connection
        onOpen(ws);

        // Wait for this socket to close, then loop back and reconnect
        await new Promise((resolve) => {
          ws.on("close", resolve);
          ws.on("error", resolve);
        });

        if (stopped) return;

        attempt++;
        if (attempt > MAX_RECONNECT_ATTEMPTS) {
          onGiveUp(new Error(`Gave up reconnecting after ${MAX_RECONNECT_ATTEMPTS} attempts`));
          return;
        }

        const delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
        onReconnecting?.(`Connection lost — reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS})`);
        await sleep(delay);
      } catch (err) {
        attempt++;
        if (attempt > MAX_RECONNECT_ATTEMPTS) {
          onGiveUp(err);
          return;
        }
        const delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
        onReconnecting?.(`Connect failed (${err.message}) — retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS})`);
        await sleep(delay);
      }
    }
  }

  connectLoop();

  return {
    getSocket: () => current,
    stop: () => { stopped = true; current?.close(); },
  };
}
