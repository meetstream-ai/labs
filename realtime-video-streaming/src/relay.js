/**
 * Relay: re-broadcasts the live fMP4 byte stream to local consumers on WS /stream.
 *
 * fMP4 is append-only: an initialisation segment (ftyp + moov) followed by a
 * sequence of media segments (moof + mdat). A consumer that joins mid-meeting has
 * missed the initialisation segment and cannot decode anything without it, so the
 * relay caches it and replays it to every new consumer before live media.
 *
 * Caveat, stated honestly: the cache is built by buffering incoming chunks until
 * one of them contains the ASCII bytes "moov". If your encoder ever splits the moov
 * box across a boundary in a way that lands the marker late, a late joiner gets a
 * slightly larger prefix than strictly necessary: harmless. Consumers that connect
 * before the first chunk arrives always get a byte-perfect stream.
 */

import { WebSocket } from "ws";

// A consumer that cannot keep up with live video buffers unboundedly in memory.
// 8 MB is a few seconds of 1080p: enough to ride out jitter, small enough to
// catch a genuinely stuck client.
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const MOOV = Buffer.from("moov", "ascii");

export class Relay {
  constructor(logger) {
    this.logger = logger;
    this.clients = new Set();
    this.startMessage = null;   // the video_stream_start JSON, replayed to new clients
    this.initChunks = [];       // buffered until moov is seen
    this.initSegment = null;    // frozen initialisation segment
  }

  get size() {
    return this.clients.size;
  }

  /** Remember the video_stream_start payload so late joiners learn the format. */
  setStartMessage(msg) {
    this.startMessage = msg;
    this.#sendAll(JSON.stringify(msg));
  }

  add(ws) {
    this.clients.add(ws);
    this.logger.info(`Relay consumer connected (${this.clients.size} listening)`);

    if (this.startMessage) this.#send(ws, JSON.stringify(this.startMessage));
    if (this.initSegment) this.#send(ws, this.initSegment);

    ws.on("close", () => {
      this.clients.delete(ws);
      this.logger.info(`Relay consumer disconnected (${this.clients.size} remaining)`);
    });

    ws.on("error", (err) => {
      this.logger.error("Relay consumer error", err);
      this.clients.delete(ws);
    });
  }

  /** @param {Buffer} chunk raw fMP4 bytes straight off the bot socket */
  broadcast(chunk) {
    if (!this.initSegment) {
      this.initChunks.push(chunk);
      if (chunk.includes(MOOV)) {
        this.initSegment = Buffer.concat(this.initChunks);
        this.initChunks = [];
        this.logger.detail(`Cached fMP4 init segment (${this.initSegment.length} bytes)`);
      } else if (this.initChunks.length > 32) {
        // Never buffer forever if moov is not where we expect it.
        this.initSegment = Buffer.concat(this.initChunks);
        this.initChunks = [];
        this.logger.warn("No moov box found in the first 32 chunks: caching them as-is.");
      }
    }

    if (this.clients.size === 0) return;

    const dead = [];
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) {
        dead.push(ws);
        continue;
      }
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        this.logger.warn(
          `Relay consumer too slow (${(ws.bufferedAmount / 1048576).toFixed(1)} MB buffered): dropping it`
        );
        ws.terminate();
        dead.push(ws);
        continue;
      }
      this.#send(ws, chunk);
    }
    for (const ws of dead) this.clients.delete(ws);
  }

  /** Tell consumers the meeting stream is over, then close them. */
  end(payload) {
    this.#sendAll(JSON.stringify(payload));
    for (const ws of this.clients) {
      try {
        ws.close(1000, "stream ended");
      } catch {
        /* already gone */
      }
    }
    this.clients.clear();
  }

  #sendAll(data) {
    for (const ws of this.clients) this.#send(ws, data);
  }

  #send(ws, data) {
    try {
      ws.send(data);
    } catch {
      /* client already gone: pruned on the next broadcast */
    }
  }
}
