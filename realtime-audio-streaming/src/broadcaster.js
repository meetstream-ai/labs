/**
 * Broadcaster
 * ─────────────────────────────────────────────────────────────────────────────
 * Maintains a set of WebSocket clients connected to WS /stream and
 * re-broadcasts every audio frame to all of them the moment it arrives.
 *
 * Frame format sent to each consumer:
 *
 *   ┌─────────────┬──────────────────┬────────────┬──────────────────┐
 *   │ name_length │  speaker_name    │ pcm_length │   pcm_data       │
 *   │  1 byte     │  N bytes (UTF-8) │  4 bytes   │  M bytes PCM16LE │
 *   └─────────────┴──────────────────┴────────────┴──────────────────┘
 *
 * Audio spec: PCM16 little-endian, 48 000 Hz, mono.
 *
 * On connect, clients receive one JSON text frame:
 *   { "type": "ready", "format": "PCM16LE", "sampleRate": 48000, "channels": 1 }
 *
 * Multiple consumers can connect simultaneously — all receive the same stream.
 */

import { WebSocket } from "ws";
import chalk from "chalk";

// If a consumer's outbound buffer grows past this, they're too slow to keep
// up with live audio — disconnect them rather than let memory grow unbounded.
// 2MB ≈ ~10 seconds of buffered 48kHz/16-bit/mono audio, generous enough to
// absorb brief network jitter but small enough to catch a truly stuck client.
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

export class Broadcaster {
  constructor(logger) {
    this.logger  = logger;
    this.clients = new Set();
  }

  get size() { return this.clients.size; }

  /**
   * Register a new consumer WebSocket (called from app.ws("/stream")).
   * Sends a "ready" handshake then starts delivering frames.
   */
  add(ws) {
    this.clients.add(ws);
    const count = this.clients.size;
    this.logger.info(
      chalk.green(`📡  Stream consumer connected`) +
      chalk.dim(` — ${count} client${count === 1 ? "" : "s"} listening`)
    );

    // Handshake: tell the client exactly what it will receive
    this.#send(ws, JSON.stringify({
      type: "ready",
      format: "PCM16LE",
      sampleRate: 48000,
      channels: 1,
      frameFormat: "1-byte name_length | N-byte speaker_name | 4-byte pcm_length LE | M-byte pcm_data",
    }));

    ws.on("close", () => {
      this.clients.delete(ws);
      this.logger.info(
        chalk.yellow(`📡  Stream consumer disconnected`) +
        chalk.dim(` — ${this.clients.size} remaining`)
      );
    });

    ws.on("error", (err) => {
      this.logger.error("Stream consumer WS error", err);
      this.clients.delete(ws);
    });
  }

  /**
   * Called by AudioHandler for every decoded PCM frame.
   * Builds a lightweight binary envelope and sends to all live consumers.
   *
   * Backpressure: any consumer whose buffered (unsent) bytes exceed
   * MAX_BUFFERED_BYTES is forcibly disconnected. A slow consumer otherwise
   * causes Node to queue frames in memory indefinitely — this caps that.
   *
   * @param {string} speakerName
   * @param {Buffer} pcmBuffer  — raw PCM16 LE bytes
   */
  broadcast(speakerName, pcmBuffer) {
    if (this.clients.size === 0) return;  // nobody listening — skip encoding

    const frame = this.#buildFrame(speakerName, pcmBuffer);
    let dead = null;

    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) {
        (dead ??= []).push(ws);
        continue;
      }

      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        this.logger.error(
          `Stream consumer too slow (${(ws.bufferedAmount / 1024).toFixed(0)} KB buffered) — disconnecting`
        );
        ws.terminate();
        (dead ??= []).push(ws);
        continue;
      }

      this.#send(ws, frame);
    }

    // Prune any sockets that closed or were terminated this round
    if (dead) for (const ws of dead) this.clients.delete(ws);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /** Pack: [1 byte name_len][name UTF-8][4 byte pcm_len LE][pcm bytes] */
  #buildFrame(speakerName, pcmBuffer) {
    const nameBytes = Buffer.from(speakerName ?? "", "utf8").slice(0, 255);
    const nameLen   = nameBytes.length;
    const pcmLen    = pcmBuffer.length;

    const out = Buffer.allocUnsafe(1 + nameLen + 4 + pcmLen);
    let offset = 0;

    out.writeUInt8(nameLen, offset);    offset += 1;
    nameBytes.copy(out, offset);        offset += nameLen;
    out.writeUInt32LE(pcmLen, offset);  offset += 4;
    pcmBuffer.copy(out, offset);

    return out;
  }

  #send(ws, data) {
    try { ws.send(data); } catch { /* client already gone */ }
  }
}