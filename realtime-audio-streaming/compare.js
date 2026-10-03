#!/usr/bin/env node
/**
 * compare.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Side-by-side comparison of the streaming providers in src/providers/.
 *
 * bridge.js sends the audio to ONE provider, picked by STT_PROVIDER. This
 * sends the same audio to ALL of them at once and tabulates, per provider,
 * word error rate against a reference and how quickly final transcripts
 * arrive. Two sources:
 *
 *   From a file (no meeting, anyone can reproduce it):
 *     npm run compare -- --file clip.wav --reference clip.txt
 *
 *   From a live meeting (with `npm start` running in another terminal):
 *     npm run compare -- --live [--reference what-was-said.txt]
 *
 * By default every provider whose API key is set in .env takes part; pick
 * some with --providers deepgram,assemblyai. For a file with a known
 * transcript, ../transcription-provider-benchmark builds a pinned one
 * (npm run fetch-sample there: sample/clip.wav + sample/reference.txt), the
 * same clip its post-call benchmark uses.
 *
 * Results go to results/compare-<time>/: results.md (the table), and
 * results.json with every final transcript and its timing.
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { parseArgs } from "util";
import { WebSocket } from "ws";
import { readWav, resampleTo48k, replay, runComparison, renderMarkdown } from "./src/comparison.js";

const KEYS = {
  deepgram: "DEEPGRAM_API_KEY",
  assemblyai: "ASSEMBLYAI_API_KEY",
  "openai-whisper": "OPENAI_API_KEY",
};

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    live: { type: "boolean", default: false },
    reference: { type: "string" },
    providers: { type: "string" },
    "stream-url": { type: "string", default: process.env.STREAM_URL || "ws://localhost:3000/stream" },
  },
});

if (!values.file === !values.live) {
  console.error("Usage: npm run compare -- --file clip.wav [--reference clip.txt]");
  console.error("       npm run compare -- --live [--reference said.txt]   (with `npm start` running)");
  process.exit(1);
}

const names = values.providers
  ? values.providers.split(",").map((s) => s.trim()).filter(Boolean)
  : Object.keys(KEYS).filter((k) => process.env[KEYS[k]]);
if (!names.length) {
  console.error(`No providers to compare. Set at least one of ${Object.values(KEYS).join(", ")} in .env,`);
  console.error("or name them with --providers.");
  process.exit(1);
}

const providers = [];
for (const key of names) {
  try {
    providers.push({ key, impl: (await import(`./src/providers/${key}.js`)).default });
  } catch (err) {
    console.error(`✖ Could not load src/providers/${key}.js: ${err.message}`);
    process.exit(1);
  }
}

const reference = values.reference ? fs.readFileSync(values.reference, "utf8") : undefined;

let feed;
let source;
if (values.file) {
  const { sampleRate, pcm } = readWav(fs.readFileSync(values.file));
  const audio = resampleTo48k(pcm, sampleRate);
  source = `file \`${values.file}\` (${sampleRate} Hz, resampled to 48 kHz)`;
  feed = (send) => replay(audio, send);
} else {
  source = `live meeting audio from ${values["stream-url"]}`;
  // Same /stream framing bridge.js reads: [1B name_len][name][4B pcm_len LE][pcm]
  feed = (send) => new Promise((resolve, reject) => {
    const ws = new WebSocket(values["stream-url"]);
    ws.on("message", (raw) => {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (buf[0] === 0x7b) return; // JSON handshake
      let off = 0;
      const nameLen = buf.readUInt8(off); off += 1;
      const speaker = buf.toString("utf8", off, off + nameLen); off += nameLen;
      const pcmLen = buf.readUInt32LE(off); off += 4;
      const pcm = buf.subarray(off, off + pcmLen);
      if (pcm.length) send(pcm, speaker);
    });
    ws.on("open", () => console.log("  listening to the meeting; press Ctrl+C when the audio you want to compare has ended"));
    ws.on("close", resolve);
    ws.on("error", (err) => reject(new Error(`${err.message} (is \`npm start\` running?)`)));
    process.once("SIGINT", () => ws.close());
  });
}

console.log(`\nComparing ${names.join(", ")}`);
console.log(`Source: ${source}${reference ? `, reference ${values.reference}` : ", no reference (latency only)"}\n`);

const result = await runComparison({ providers, feed, reference, log: (l) => console.log(l) });

const dir = path.join("results", `compare-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}Z`);
fs.mkdirSync(dir, { recursive: true });
const markdown = renderMarkdown(result, { source });
fs.writeFileSync(path.join(dir, "results.md"), markdown);
fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify({ source, providers: names, ...result }, null, 2) + "\n");
if (reference) fs.writeFileSync(path.join(dir, "reference.txt"), reference);

console.log("\n" + markdown);
console.log(`Results -> ${path.join(dir, "results.md")}\n`);
process.exit(0);
