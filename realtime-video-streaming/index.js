#!/usr/bin/env node
/**
 * MeetStream Labs: Real-Time Video Streaming
 * ===========================================
 * Receives a bot's live video as fMP4 over a WebSocket, writes it to a playable
 * file, and relays it to any local consumer.
 *
 *   node index.js
 *
 * What happens:
 *   1. An HTTP server starts locally with
 *        POST /webhook : bot lifecycle events
 *        WS   /video     the bot's live fMP4 stream (MeetStream connects here)
 *        WS   /stream    live fMP4 relayed out to your own consumers
 *        GET  /health
 *   2. A public HTTPS URL is resolved (PUBLIC_URL, or an ngrok tunnel).
 *   3. POST /bots/create_bot sends a bot into your meeting with
 *        live_video_required: { websocket_url: "wss://<public>/video" }
 *   4. Video is written to ./output/<bot_id>-<ts>.mp4 while it streams.
 *   5. Ctrl+C removes the bot and finalises the file.
 *
 * Live video is supported on Google Meet and Microsoft Teams. Not on Zoom.
 */

import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

import { log, c } from "./src/logger.js";
import { MeetStreamClient, MeetStreamError } from "./src/meetstream.js";
import { resolvePublicUrl, toWss } from "./src/tunnel.js";
import { VideoSink } from "./src/video-sink.js";
import { Relay } from "./src/relay.js";

// ── Config ────────────────────────────────────────────────────────────────────

for (const key of ["MEETSTREAM_API_KEY", "MEETING_LINK"]) {
  if (!process.env[key]) {
    console.error(`\nMissing required env var: ${key}`);
    console.error("Copy .env.example to .env and fill it in.\n");
    process.exit(1);
  }
}

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const BOT_NAME = process.env.BOT_NAME || "MeetStream Labs Video Bot";
const OUTPUT_DIR = process.env.OUTPUT_DIR || "./output";
const MAX_RELAY_CLIENTS = Number.parseInt(process.env.MAX_RELAY_CLIENTS ?? "5", 10);

// ── Server ────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "2mb" }));

const server = createServer(app);
const relay = new Relay(log);
const sink = new VideoSink({ outputDir: OUTPUT_DIR, relay, logger: log });

let botId = null;

app.post("/webhook", (req, res) => {
  res.sendStatus(200); // ack fast: MeetStream does not retry non-2xx
  const body = req.body;
  if (!body || typeof body !== "object") {
    log.warn("Ignoring malformed webhook payload");
    return;
  }
  log.event(body);
  if (body.event === "bot.stopped") {
    log.warn(`Bot stopped. Reason: ${body.bot_status ?? "unknown"}`);
  }
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    bot_id: botId,
    bytes_received: sink.bytes,
    relay_consumers: relay.size,
  });
});

// Video frames can be large; raise the payload ceiling well above the default.
const videoWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
const relayWss = new WebSocketServer({ noServer: true });

videoWss.on("connection", (ws) => sink.attach(ws));

relayWss.on("connection", (ws) => {
  if (relay.size >= MAX_RELAY_CLIENTS) {
    ws.close(1013, "too many relay consumers");
    return;
  }
  relay.add(ws);
});

server.on("upgrade", (req, socket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {
    socket.destroy();
    return;
  }

  if (pathname === "/video") {
    videoWss.handleUpgrade(req, socket, head, (ws) => videoWss.emit("connection", ws, req));
  } else if (pathname === "/stream") {
    relayWss.handleUpgrade(req, socket, head, (ws) => relayWss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log.banner("MeetStream Labs: Real-Time Video Streaming", "live fMP4 over WebSocket");

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, resolve);
  });
  log.info(`Local server on port ${c("green", PORT)}`);

  const tunnel = await resolvePublicUrl(PORT);
  log.info(`Public URL (${tunnel.source}): ${c("cyan", tunnel.url)}`);

  const callbackUrl = `${tunnel.url}/webhook`;
  const videoWsUrl = `${toWss(tunnel.url)}/video`;
  log.detail(`callback_url        = ${callbackUrl}`);
  log.detail(`live video websocket = ${videoWsUrl}`);

  const client = new MeetStreamClient(process.env.MEETSTREAM_API_KEY, { logger: log });

  log.info("Creating bot…");
  const bot = await client.createBot({
    meeting_link: process.env.MEETING_LINK,
    bot_name: BOT_NAME,

    // This is the post-call recording toggle and is independent of live
    // streaming. Set VIDEO_RECORDING=true if you also want a downloadable
    // recording afterwards via GET /bots/{id}/get_video.
    video_required: process.env.VIDEO_RECORDING === "true",

    callback_url: callbackUrl,

    // The whole point of this template: the bot dials out to our WebSocket and
    // pushes fMP4 chunks as the meeting happens.
    live_video_required: { websocket_url: videoWsUrl },

    recording_config: {
      retention: { type: "timed", hours: 24 },
    },

    automatic_leave: {
      waiting_room_timeout: 600,
      everyone_left_timeout: 60,
      in_call_recording_timeout: 14400, // minimum accepted value is 600
    },
  });

  botId = bot.bot_id;
  log.success(`Bot created: ${c("bold", botId)} (status: ${bot.status})`);
  log.info("Waiting for the bot to join and start streaming…");
  log.detail(`Relay for your own consumers: ws://localhost:${PORT}/stream`);
  log.detail("Press Ctrl+C to remove the bot and finalise the file.");
  console.log("");

  // ── Shutdown ────────────────────────────────────────────────────────────────
  let shuttingDown = false;
  async function shutdown(reason, code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("");
    log.info(`Shutting down (${reason})…`);

    sink.finalize();

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

  // Never leave an orphaned bot sitting in someone's meeting because of a crash.
  process.on("uncaughtException", (err) => {
    log.error("Uncaught exception", err);
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (err) => {
    log.error("Unhandled rejection", err instanceof Error ? err : new Error(String(err)));
    void shutdown("unhandledRejection", 1);
  });
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
