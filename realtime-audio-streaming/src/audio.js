/**
 * AudioHandler
 * ─────────────────────────────────────────────────────────────────────────────
 * Receives binary frames from MeetStream's live_audio_required WebSocket.
 *
 * Binary frame format (MeetStream → us):
 *   Offset  Size      Field
 *   ──────  ────────  ─────────────────────────────────────────────
 *   0       1 byte    msg_type
 *   1       2 bytes   sid_length  (uint16 LE)
 *   3       sid_len   speaker_id  (UTF-8)
 *   3+sid   2 bytes   sname_length (uint16 LE)
 *   5+sid   sname_len speaker_name (UTF-8)
 *   rest    variable  PCM audio data (PCM16 LE, 48kHz, mono)
 *
 * On every frame:
 *   1. PCM is extracted from the binary envelope
 *   2. Forwarded live to Broadcaster → all /stream consumers
 *   3. Appended to a per-speaker .wav file (archive)
 */

import { mkdirSync, openSync, writeSync, closeSync } from "fs";
import { join } from "path";
import chalk from "chalk";

const AUDIO_DIR       = "./logs/audio";
const SAMPLE_RATE     = 48000;
const NUM_CHANNELS    = 1;
const BITS_PER_SAMPLE = 16;
const BYTE_RATE       = SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
const BLOCK_ALIGN     = NUM_CHANNELS * (BITS_PER_SAMPLE / 8);

mkdirSync(AUDIO_DIR, { recursive: true });

// ── WAV helpers ───────────────────────────────────────────────────────────────

function makeWavHeader(dataSize = 0) {
  const buf = Buffer.alloc(44);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(NUM_CHANNELS, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(BYTE_RATE, 28);
  buf.writeUInt16LE(BLOCK_ALIGN, 32);
  buf.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

function patchWavSizes(fd, dataBytes) {
  const tmp = Buffer.alloc(4);
  tmp.writeUInt32LE(36 + dataBytes, 0);
  writeSync(fd, tmp, 0, 4, 4);   // ChunkSize
  tmp.writeUInt32LE(dataBytes, 0);
  writeSync(fd, tmp, 0, 4, 40);  // Subchunk2Size
}

// ── AudioHandler ──────────────────────────────────────────────────────────────

export class AudioHandler {
  /**
   * @param {import('./logger.js').Logger} logger
   * @param {import('./broadcaster.js').Broadcaster} broadcaster
   */
  constructor(logger, broadcaster) {
    this.logger      = logger;
    this.broadcaster = broadcaster;
    this.totalBytes  = 0;
    this.frameCount  = 0;
    this.speakers    = {};
    this.lastLogTime = Date.now();
  }

  handleMeta(_meta) {}

  /** Parse MeetStream binary frame → broadcast live → append to .wav */
  handleFrame(buffer) {
    if (buffer.length < 5) return;

    try {
      let offset = 0;

      // msg_type (1 byte)
      offset += 1;

      // speaker ID
      const sidLen    = buffer.readUInt16LE(offset); offset += 2;
      const speakerId = buffer.toString("utf8", offset, offset + sidLen); offset += sidLen;

      // speaker name
      if (offset + 2 > buffer.length) return;
      const snameLen    = buffer.readUInt16LE(offset); offset += 2;
      const speakerName = buffer.toString("utf8", offset, offset + snameLen); offset += snameLen;

      // PCM payload
      const pcm = buffer.slice(offset);
      if (pcm.length === 0) return;

      this.totalBytes += pcm.length;
      this.frameCount++;

      // Fallback labels when diarization hasn't fired yet
      const resolvedId   = speakerId.trim()   || "unidentified";
      const resolvedName = speakerName.trim() || "Unidentified Speaker";

      // ── 1. Broadcast to all live /stream consumers (zero-copy, immediate) ──
      this.broadcaster.broadcast(resolvedName, pcm);

      // ── 2. Append to per-speaker .wav archive ────────────────────────────
      if (!this.speakers[resolvedId]) this.#initSpeaker(resolvedId, resolvedName);
      const spk = this.speakers[resolvedId];
      spk.bytes += pcm.length;
      spk.frames++;
      writeSync(spk.fd, pcm);

      // ── 3. Terminal energy meter (every 2 s) ─────────────────────────────
      const now = Date.now();
      if (now - this.lastLogTime > 2000) {
        this.lastLogTime = now;
        const rms      = this.#rms(pcm);
        const bar      = this.#energyBar(rms);
        const speaking = rms > 200;
        const kb       = (this.totalBytes / 1024).toFixed(1);
        const clients  = chalk.dim(`[${this.broadcaster.size} consumer${this.broadcaster.size === 1 ? "" : "s"}]`);
        const label    = chalk.magenta(resolvedName.padEnd(22));
        this.logger.audio(
          `${label} ${bar} ${speaking ? chalk.green("● speaking") : chalk.dim("○ silence ")}  ${chalk.dim(kb + " KB")}  ${clients}`
        );
      }
    } catch (err) {
      this.logger.error("Bad audio frame", err);
    }
  }

  /**
   * Patch WAV headers with final sizes and close all file descriptors.
   * Safe to call more than once — the audio WS close event and the
   * SIGINT/SIGTERM handler can both trigger this; already-finalized
   * speakers are skipped so we never write to a closed fd.
   */
  flush() {
    for (const [, info] of Object.entries(this.speakers)) {
      if (info.finalized) continue;   // already closed by an earlier flush() call
      try {
        patchWavSizes(info.fd, info.bytes);
        closeSync(info.fd);
        info.finalized = true;
        const kb  = (info.bytes / 1024).toFixed(1);
        const dur = (info.bytes / (SAMPLE_RATE * 2)).toFixed(1);
        this.logger.info(
          `Saved → ${chalk.cyan(info.filepath)}  (${kb} KB · ${dur}s · ${info.frames} frames)`
        );
      } catch (e) {
        this.logger.error(`Failed to finalise ${info.filepath}`, e);
      }
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  #initSpeaker(id, name) {
    const safe     = (name || id).replace(/[^a-z0-9_-]/gi, "_").slice(0, 40);
    const filepath = join(AUDIO_DIR, `${safe}_${Date.now()}.wav`);
    const fd       = openSync(filepath, "w");
    writeSync(fd, makeWavHeader(0));
    this.speakers[id] = { name, bytes: 0, frames: 0, fd, filepath, finalized: false };
    this.logger.info(`New speaker: ${chalk.magenta(name)}  →  ${chalk.cyan(filepath)}`);
    this.logger.info(chalk.dim(`  WAV 48kHz 16-bit mono · also streaming live on ws://localhost/stream`));
  }

  #rms(buf) {
    let sum = 0;
    const n = Math.floor(buf.length / 2);
    if (n === 0) return 0;
    for (let i = 0; i < n; i++) { const s = buf.readInt16LE(i * 2); sum += s * s; }
    return Math.sqrt(sum / n);
  }

  #energyBar(rms) {
    const filled = Math.round((Math.min(rms, 8000) / 8000) * 8);
    const bar    = "█".repeat(filled) + "░".repeat(8 - filled);
    const color  = filled > 5 ? chalk.green : filled > 2 ? chalk.yellow : chalk.dim;
    return `[${color(bar)}]`;
  }
}