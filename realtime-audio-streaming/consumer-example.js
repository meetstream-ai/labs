/**
 * consumer-example.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Example of an external application consuming the live audio stream.
 *
 * Run AFTER `npm start` in another terminal:
 *   node consumer-example.js
 *
 * What it does:
 *   - Connects to ws://localhost:3000/stream
 *   - Receives live PCM frames from the meeting as they happen
 *   - Parses the speaker name + PCM data from each frame
 *   - Logs per-speaker audio stats in real time
 *   - You can swap the "// → do something" section with any processing:
 *       • forward to Deepgram/Whisper streaming API
 *       • pipe into ffmpeg for real-time encoding
 *       • feed a voice activity detector
 *       • push to a browser via another WebSocket
 *       • anything that consumes raw PCM
 *
 * Frame format received:
 *   ┌─────────────┬──────────────────┬────────────┬──────────────────┐
 *   │ name_length │  speaker_name    │ pcm_length │   pcm_data       │
 *   │  1 byte     │  N bytes (UTF-8) │  4 bytes   │  M bytes PCM16LE │
 *   └─────────────┴──────────────────┴────────────┴──────────────────┘
 *
 * Audio: PCM16 little-endian, 48 000 Hz, mono.
 */

import { WebSocket } from "ws";

const SERVER = process.env.STREAM_URL || "ws://localhost:3000/stream";

console.log(`\nConnecting to ${SERVER} …\n`);
const ws = new WebSocket(SERVER);

// Per-speaker stats tracked locally
const speakers = {};

ws.on("open", () => {
  console.log("Connected. Waiting for audio frames…\n");
});

ws.on("message", (raw) => {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);

  // ── Text frame: server handshake ─────────────────────────────────────────
  if (buf[0] === 0x7b) {  // '{' — JSON
    try {
      const msg = JSON.parse(buf.toString());
      if (msg.type === "ready") {
        console.log("Stream info:", msg);
        console.log();
      }
    } catch { /* ignore */ }
    return;
  }

  // ── Binary frame: parse envelope ─────────────────────────────────────────
  let offset = 0;

  const nameLen  = buf.readUInt8(offset);    offset += 1;
  const name     = buf.toString("utf8", offset, offset + nameLen); offset += nameLen;
  const pcmLen   = buf.readUInt32LE(offset); offset += 4;
  const pcm      = buf.slice(offset, offset + pcmLen);

  if (pcm.length === 0) return;

  // Track per-speaker totals
  if (!speakers[name]) speakers[name] = { bytes: 0, frames: 0 };
  speakers[name].bytes  += pcm.length;
  speakers[name].frames += 1;

  // ── → do something with pcm here ─────────────────────────────────────────
  //
  // Examples:
  //
  //   // 1. Forward to Deepgram streaming
  //   deepgramSocket.send(pcm);
  //
  //   // 2. Pipe to ffmpeg stdin for real-time MP3 encoding
  //   ffmpegProcess.stdin.write(pcm);
  //
  //   // 3. Feed a voice-activity detector
  //   vad.process(pcm);
  //
  //   // 4. Buffer N ms of audio then send to Whisper
  //   buffer.push(pcm);
  //   if (bufferDuration() > 3000) sendToWhisper(buffer.flush());
  //
  // ─────────────────────────────────────────────────────────────────────────

  // Log a summary line every ~2 seconds per speaker
  const spk = speakers[name];
  if (spk.frames % 80 === 0) {
    const kb  = (spk.bytes / 1024).toFixed(1);
    const dur = (spk.bytes / (48000 * 2)).toFixed(1);
    console.log(`${name.padEnd(22)}  ${kb.padStart(8)} KB  ${dur.padStart(6)}s received`);
  }
});

ws.on("close", () => {
  console.log("\nStream closed. Final totals:");
  for (const [name, s] of Object.entries(speakers)) {
    const kb  = (s.bytes / 1024).toFixed(1);
    const dur = (s.bytes / (48000 * 2)).toFixed(1);
    console.log(`   ${name.padEnd(24)} ${kb} KB  (${dur}s)`);
  }
  process.exit(0);
});

ws.on("error", (err) => {
  console.error("WS error:", err.message);
  console.error("Is the server running? (npm start)");
  process.exit(1);
});