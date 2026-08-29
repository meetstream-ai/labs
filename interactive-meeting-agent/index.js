#!/usr/bin/env node
/**
 * MeetStream Labs: Interactive Meeting Agent
 * ===========================================
 * A two-way loop: hear the meeting, decide, respond in the meeting.
 *
 *   node index.js
 *
 * Two channels, both pointing at this process:
 *
 *   live_audio_required   { websocket_url }  meeting audio IN  (binary PCM frames)
 *   socket_connection_url { websocket_url }  commands OUT      (sendchat, sendaudio, …)
 *
 * Plus live transcription over an HTTPS webhook, because raw PCM tells you when
 * somebody is talking but not what they said.
 *
 * Both websocket_url fields point at YOUR server. This is a bring-your-own bridge.
 * It is not how MIA works: a MIA bot is created with `agent_config_id` alone and
 * never with socket_connection_url or live_audio_required.
 *
 * The decision logic lives in src/brain.js and is a clearly-marked stub. Every
 * other part of this template is real API plumbing.
 */

import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

import { log, c } from "./src/logger.js";
import { MeetStreamClient, MeetStreamError } from "./src/meetstream.js";
import { resolvePublicUrl, toWss } from "./src/tunnel.js";
import { ControlChannel } from "./src/control-channel.js";
import { AudioIn } from "./src/audio-in.js";
import { createBrain } from "./src/brain.js";
import { loadPcm } from "./src/pcm.js";

// ── Config ────────────────────────────────────────────────────────────────────

for (const key of ["MEETSTREAM_API_KEY", "MEETING_LINK"]) {
  if (!process.env[key]) {
    console.error(`\nMissing required env var: ${key}`);
    console.error("Copy .env.example to .env and fill it in.\n");
    process.exit(1);
  }
}

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const BOT_NAME = process.env.BOT_NAME || "MeetStream Labs Agent";
const WAKE_WORD = process.env.WAKE_WORD || "hey bot";
const RESPONSE_AUDIO_FILE = process.env.RESPONSE_AUDIO_FILE || null;
const BARGE_IN = process.env.BARGE_IN !== "false";
const RMS_THRESHOLD = Number.parseInt(process.env.RMS_THRESHOLD ?? "500", 10);
const SILENCE_MS = Number.parseInt(process.env.SILENCE_MS ?? "900", 10);

// Fail before a bot is created if the response audio is missing or misencoded.
if (RESPONSE_AUDIO_FILE) {
  const { seconds } = loadPcm(RESPONSE_AUDIO_FILE);
  log.info(`Response audio ready: ${RESPONSE_AUDIO_FILE} (${seconds.toFixed(1)}s)`);
}

// ── Wiring ────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "2mb" }));

const server = createServer(app);
const channel = new ControlChannel(log);
const brain = createBrain({ wakeWord: WAKE_WORD, responseAudioFile: RESPONSE_AUDIO_FILE, logger: log });

let botId = null;

/**
 * Run whatever the brain decided. Each action maps onto one control-channel
 * command. A failing action is logged and the rest still run.
 */
async function execute(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return;

  if (!channel.connected) {
    log.warn(`Dropping ${actions.length} action(s): control channel is not connected.`);
    return;
  }

  for (const action of actions) {
    try {
      switch (action.type) {
        case "chat":
          if (action.stream) await channel.streamChat(action.text);
          else channel.sendChat(action.text);
          log.success(`sendchat → "${truncate(action.text)}"`);
          break;

        case "msg":
          channel.sendMsg(action.text);
          log.success(`sendmsg → "${truncate(action.text)}"`);
          break;

        case "interrupt":
          channel.interrupt();
          log.info("interrupt sent (clear_audio_queue: Google Meet only)");
          break;

        case "say": {
          const { pcm, seconds } = loadPcm(action.file);
          log.info(`sendaudio → ${action.file} (${seconds.toFixed(1)}s)`);
          const result = await channel.sendAudio(pcm);
          log.success(
            `sendaudio done: ${result.chunks} chunks${result.cancelled ? " (interrupted)" : ""}`
          );
          break;
        }

        default:
          log.warn(`Brain returned an unknown action type: ${action.type}`);
      }
    } catch (err) {
      log.error(`Action "${action.type}" failed`, err);
    }
  }
}

const audioIn = new AudioIn({
  logger: log,
  rmsThreshold: RMS_THRESHOLD,
  silenceMs: SILENCE_MS,

  // Barge-in: a human starting to talk while the bot is mid-sentence should stop
  // the bot, not talk over them. Only Google Meet actually clears the queue, so
  // the local send loop is cancelled too (interrupt() does both).
  onSpeechStart: ({ speaker }) => {
    if (!BARGE_IN) return;
    if (!channel.audioPlaying) return;
    log.warn(`${speaker} started speaking: interrupting the bot`);
    try {
      channel.interrupt();
    } catch (err) {
      log.error("Barge-in interrupt failed", err);
    }
  },

  onUtterance: (info) => {
    brain.onUtterance(info).then(execute, (err) => log.error("brain.onUtterance threw", err));
  },
});

// ── HTTP routes ───────────────────────────────────────────────────────────────

app.post("/webhook", (req, res) => {
  res.sendStatus(200); // ack fast: MeetStream does not retry non-2xx
  const body = req.body;
  if (!body || typeof body !== "object") {
    log.warn("Ignoring malformed webhook payload");
    return;
  }
  log.event(body);

  // Non-terminal: a streaming provider hiccuped, the bot keeps running.
  if (body.event === "bot.error") {
    log.warn(`Streaming provider error (bot continues): ${body.message ?? "no detail"}`);
  }
  if (body.event === "bot.stopped") {
    log.warn(`Bot stopped. Reason: ${body.bot_status ?? "unknown"}`);
  }
});

/**
 * Live transcript segments. Shape (live-captured):
 *   { bot_id, speakerName, timestamp, transcript, words[], is_final, ... }
 * The text field is `transcript`, not `text`.
 */
app.post("/transcript", (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  if (!body || typeof body !== "object") return;

  const text = typeof body.transcript === "string" ? body.transcript.trim() : "";
  if (!text) return;

  const speaker = body.speakerName || "Unknown";
  const isFinal = Boolean(body.is_final);

  log.detail(`[${isFinal ? "final" : "interim"}] ${speaker}: ${text}`);

  brain
    .onTranscript({ speaker, text, isFinal })
    .then(execute, (err) => log.error("brain.onTranscript threw", err));
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    bot_id: botId,
    control_connected: channel.connected,
    audio_bytes: audioIn.totalBytes,
  });
});

// ── WebSocket routing ─────────────────────────────────────────────────────────

const controlWss = new WebSocketServer({ noServer: true });
const audioWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

controlWss.on("connection", (ws) => channel.attach(ws));
audioWss.on("connection", (ws) => audioIn.attach(ws));

server.on("upgrade", (req, socket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {
    socket.destroy();
    return;
  }

  if (pathname === "/control") {
    controlWss.handleUpgrade(req, socket, head, (ws) => controlWss.emit("connection", ws, req));
  } else if (pathname === "/audio") {
    audioWss.handleUpgrade(req, socket, head, (ws) => audioWss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log.banner("MeetStream Labs: Interactive Meeting Agent", "live audio in, control channel out");

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, resolve);
  });
  log.info(`Local server on port ${c("green", PORT)}`);

  const tunnel = await resolvePublicUrl(PORT);
  const base = tunnel.url;
  const wsBase = toWss(base);

  log.info(`Public URL (${tunnel.source}): ${c("cyan", base)}`);
  log.detail(`socket_connection_url = ${wsBase}/control`);
  log.detail(`live_audio_required   = ${wsBase}/audio`);
  log.detail(`live transcription    = ${base}/transcript`);

  const client = new MeetStreamClient(process.env.MEETSTREAM_API_KEY, { logger: log });

  log.info("Creating bot…");
  const bot = await client.createBot({
    meeting_link: process.env.MEETING_LINK,
    bot_name: BOT_NAME,
    video_required: false,
    callback_url: `${base}/webhook`,

    // OUT: commands to the bot.
    socket_connection_url: { websocket_url: `${wsBase}/control` },

    // IN: raw meeting audio as binary frames.
    live_audio_required: { websocket_url: `${wsBase}/audio` },

    // IN: the words. This needs a *_streaming transcription provider, configured
    // below: a post-call provider will not feed this webhook.
    live_transcription_required: { webhook_url: `${base}/transcript` },

    recording_config: {
      transcript: {
        // meetstream_streaming is the built-in streaming provider and needs no
        // extra API key. Streaming-only providers produce no post-call transcript:
        // the lifecycle ends at audio.processed, bot.done never fires, and
        // GET /transcript/{id}/get_transcript returns 202 forever.
        provider: { meetstream_streaming: {} },
      },
      retention: { type: "timed", hours: 24 },
    },

    automatic_leave: {
      waiting_room_timeout: 600,
      everyone_left_timeout: 60,
      in_call_recording_timeout: 14400, // minimum accepted value is 600
      voice_inactivity_timeout: 900,
    },
  });

  botId = bot.bot_id;
  log.success(`Bot created: ${c("bold", botId)} (status: ${bot.status})`);
  log.info(`Wake word: "${c("bold", WAKE_WORD)}": say it in the meeting to trigger the brain.`);
  log.detail("The brain in src/brain.js is a stub. Plug your LLM in there.");
  log.detail("Press Ctrl+C to remove the bot and exit.");
  console.log("");

  channel.onReady = () => log.success("Agent is live: listening and able to respond.");
  channel.onClose = () => log.warn("Control channel gone: responses will be dropped.");

  // ── Shutdown ────────────────────────────────────────────────────────────────
  let shuttingDown = false;
  async function shutdown(reason, code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("");
    log.info(`Shutting down (${reason})…`);

    audioIn.stop();

    if (botId) {
      try {
        await client.removeBot(botId);
        log.success(`Bot ${botId} removed from the meeting.`);
      } catch (err) {
        log.error("removeBot failed. Remove it from the dashboard if it is still in the call", err);
      }
    }

    await tunnel.close();
    server.close();
    setTimeout(() => process.exit(code), 250).unref();
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => void shutdown(signal));
  }

  process.on("uncaughtException", (err) => {
    log.error("Uncaught exception", err);
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (err) => {
    log.error("Unhandled rejection", err instanceof Error ? err : new Error(String(err)));
    void shutdown("unhandledRejection", 1);
  });
}

function truncate(text, max = 70) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

main().catch((err) => {
  if (err instanceof MeetStreamError) {
    log.error(`MeetStream API ${err.status} on ${err.path}: ${err.message}`);
    if (err.hint) log.detail(err.hint);
  } else {
    log.error("Fatal error", err);
  }
  process.exit(1);
});
