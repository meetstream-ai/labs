#!/usr/bin/env node
/**
 * bridge.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Generic external-application bridge.
 *
 * Connects to YOUR live /stream WebSocket (where MeetStream audio is being
 * broadcast) and forwards every frame to whichever provider is configured —
 * Deepgram, AssemblyAI, your own in-house service, or anything else that
 * implements the provider interface in src/providers/provider-interface.js.
 *
 * ── To change the external application ───────────────────────────────────
 *
 *   1. Set STT_PROVIDER in .env to one of: deepgram | assemblyai | console
 *      (or the name of any new file you add to src/providers/)
 *   2. Add that provider's API key to .env (see its file for the exact name)
 *   3. Run:  node bridge.js
 *
 * No code changes needed to switch providers — this file never imports a
 * specific provider directly; it loads whichever one .env points to.
 *
 * ── Adding a brand-new external application ──────────────────────────────
 *
 *   1. Create src/providers/your-app.js implementing the 3 methods described
 *      in src/providers/provider-interface.js (connect / sendAudio / disconnect)
 *   2. Set STT_PROVIDER=your-app in .env
 *   3. Run:  node bridge.js
 *
 * That's the entire integration surface. The rest of this file — reading
 * /stream, parsing frames, printing results, reconnect/shutdown handling —
 * is shared infrastructure that every provider gets for free.
 */

import "dotenv/config";
import { WebSocket } from "ws";
import chalk from "chalk";

const LOCAL_STREAM_URL = process.env.STREAM_URL || "ws://localhost:3000/stream";
const PROVIDER_NAME = process.env.STT_PROVIDER || "console";

console.log(chalk.bold.cyan("\nMeetStream Labs — External Application Bridge\n"));
console.log(chalk.dim(`Local stream : ${LOCAL_STREAM_URL}`));
console.log(chalk.dim(`Provider     : ${PROVIDER_NAME}\n`));

// ── 1. Dynamically load the selected provider ─────────────────────────────────
let provider;
try {
  const mod = await import(`./src/providers/${PROVIDER_NAME}.js`);
  provider = mod.default;
} catch (err) {
  console.error(chalk.red(`\n✖  Could not load provider "${PROVIDER_NAME}"`));
  console.error(chalk.yellow(`   Looked for: src/providers/${PROVIDER_NAME}.js`));
  console.error(chalk.yellow(`   Available providers in src/providers/: deepgram, assemblyai, console`));
  console.error(chalk.yellow(`   Set STT_PROVIDER in .env to one of those, or add your own file.\n`));
  console.error(chalk.dim(err.message));
  process.exit(1);
}

let localSocket = null;
let framesForwarded = 0;
let bytesForwarded = 0;
let shuttingDown = false;

// ── 2. Result callback — every provider calls this with whatever it produces ──
function onResult(text, isFinal, meta = {}) {
  const tag = isFinal ? chalk.green("✔ FINAL") : chalk.dim("… interim");
  const extra = meta.confidence ? chalk.dim(` [${meta.confidence.toFixed?.(2) ?? meta.confidence}]`) : "";
  console.log(`${tag}  ${chalk.white(text)}${extra}`);
}

// ── 3. Connect provider, then connect to local /stream ────────────────────────
async function main() {
  console.log(chalk.cyan(`Connecting to ${provider.name}…`));
  try {
    await provider.connect(onResult);
  } catch (err) {
    console.error(chalk.red(`✖  Failed to connect to ${provider.name}:`), err.message);
    process.exit(1);
  }
  console.log(chalk.green(`✔  Connected to ${provider.name}`));

  connectToLocalStream();
}

function connectToLocalStream() {
  console.log(chalk.cyan(`Connecting to local stream: ${LOCAL_STREAM_URL} …`));
  localSocket = new WebSocket(LOCAL_STREAM_URL);

  localSocket.on("open", () => {
    console.log(chalk.green("✔  Connected to your /stream endpoint"));
    console.log(chalk.dim("Waiting for meeting audio… speak in the meeting now.\n"));
  });

  localSocket.on("message", (raw) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);

    // Text frame = server handshake JSON ({ type: "ready", ... }) — ignore
    if (buf[0] === 0x7b) return;

    // Binary frame: [1B name_len][name][4B pcm_len LE][pcm]
    let offset = 0;
    const nameLen = buf.readUInt8(offset); offset += 1;
    const speakerName = buf.toString("utf8", offset, offset + nameLen); offset += nameLen;
    const pcmLen = buf.readUInt32LE(offset); offset += 4;
    const pcm = buf.slice(offset, offset + pcmLen);

    if (pcm.length === 0) return;

    framesForwarded++;
    bytesForwarded += pcm.length;

    provider.sendAudio(pcm, speakerName);
  });

  localSocket.on("close", () => {
    if (shuttingDown) return;
    console.log(chalk.yellow("Local stream closed."));
    shutdown();
  });

  localSocket.on("error", (err) => {
    console.error(chalk.red("✖  Local stream error:"), err.message);
    console.error(chalk.yellow("   Is `npm start` running in another terminal?"));
    process.exit(1);
  });
}

// ── 4. Shutdown ────────────────────────────────────────────────────────────────
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(chalk.dim("\nShutting down bridge…"));
  console.log(chalk.dim(`  Total forwarded: ${(bytesForwarded / 1024).toFixed(1)} KB across ${framesForwarded} frames`));
  try { await provider.disconnect(); } catch { /* best effort */ }
  if (localSocket && localSocket.readyState === WebSocket.OPEN) localSocket.close();
  setTimeout(() => process.exit(0), 300);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main();
