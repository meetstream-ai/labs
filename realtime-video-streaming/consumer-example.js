#!/usr/bin/env node
/**
 * Minimal consumer of the live relay.
 *
 *   Terminal 1:  node index.js            (joins the meeting, opens the relay)
 *   Terminal 2:  node consumer-example.js (reads the relay, writes its own copy)
 *
 * What arrives on ws://localhost:3000/stream:
 *   - one JSON text frame with the original video_stream_start payload
 *   - binary fMP4 chunks, in order (a late joiner gets the cached init segment first)
 *   - one JSON text frame with video_stream_end when the meeting stream stops
 *
 * Anything that can consume a byte stream works here: an ffmpeg subprocess, an
 * HLS packager, a frame sampler feeding a vision model, an S3 multipart upload.
 */

import "dotenv/config";
import { WebSocket } from "ws";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const URL_ = process.env.RELAY_URL || `ws://localhost:${PORT}/stream`;
const OUTPUT_DIR = process.env.OUTPUT_DIR || "./output";

mkdirSync(OUTPUT_DIR, { recursive: true });
const outPath = join(OUTPUT_DIR, `consumer-copy-${Date.now()}.mp4`);
const out = createWriteStream(outPath);

let bytes = 0;
let chunks = 0;

console.log(`Connecting to ${URL_} …`);
const ws = new WebSocket(URL_, { maxPayload: 64 * 1024 * 1024 });

ws.on("open", () => console.log(`Connected. Writing to ${outPath}`));

ws.on("message", (data, isBinary) => {
  if (!isBinary) {
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    if (msg.type === "video_stream_start") {
      console.log(
        `Format: ${msg.codec}/${msg.audio_codec} in ${msg.container} ` +
        `${msg.width}x${msg.height} @ ${msg.framerate}fps`
      );
    } else if (msg.type === "video_stream_end") {
      console.log(`Stream ended after ${msg.duration_seconds}s`);
    }
    return;
  }

  const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
  bytes += chunk.length;
  chunks++;
  out.write(chunk);

  if (chunks % 50 === 0) {
    console.log(`  ${(bytes / 1048576).toFixed(2)} MB · ${chunks} chunks`);
  }
});

ws.on("close", (code) => {
  out.end();
  console.log(`Closed (code ${code}). Wrote ${(bytes / 1048576).toFixed(2)} MB to ${outPath}`);
  process.exit(0);
});

ws.on("error", (err) => {
  console.error(`Relay connection error: ${err.message}`);
  console.error("Is `node index.js` running in another terminal?");
  process.exit(1);
});

process.on("SIGINT", () => ws.close(1000, "bye"));
