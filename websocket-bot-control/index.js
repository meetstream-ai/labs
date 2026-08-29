#!/usr/bin/env node
/**
 * MeetStream Labs: WebSocket Bot Control
 * =======================================
 * The bring-your-own bridge control channel.
 *
 *   node index.js
 *
 * What happens:
 *   1. A local server starts with
 *        POST /webhook    bot lifecycle events
 *        WS   /control    the control channel (MeetStream connects here)
 *        GET  /health
 *   2. A public HTTPS URL is resolved (PUBLIC_URL, or an ngrok tunnel).
 *   3. POST /bots/create_bot sends a bot into your meeting with
 *        socket_connection_url: { websocket_url: "wss://<public>/control" }
 *   4. The bot joins, dials back, and sends { type: "ready", bot_id, message }.
 *   5. An interactive prompt lets you issue every control command by hand:
 *        sendaudio · sendmsg · sendchat · interrupt · sendimg · sendimg_url
 *
 * socket_connection_url points at YOUR server. It is not a MeetStream-hosted
 * bridge, and it is not how MIA works: a MIA bot is created with
 * `agent_config_id` alone and never with socket_connection_url.
 */

import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

import { log, c } from "./src/logger.js";
import { MeetStreamClient, MeetStreamError } from "./src/meetstream.js";
import { resolvePublicUrl, toWss } from "./src/tunnel.js";
import { ControlChannel } from "./src/control-channel.js";
import { startRepl } from "./src/repl.js";

// ── Config ────────────────────────────────────────────────────────────────────

for (const key of ["MEETSTREAM_API_KEY", "MEETING_LINK"]) {
  if (!process.env[key]) {
    console.error(`\nMissing required env var: ${key}`);
    console.error("Copy .env.example to .env and fill it in.\n");
    process.exit(1);
  }
}

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const BOT_NAME = process.env.BOT_NAME || "MeetStream Labs Control Bot";
const GREETING = process.env.GREETING ?? "";

// ── Server ────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "2mb" }));

const server = createServer(app);
const channel = new ControlChannel(log);

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
  res.json({ ok: true, bot_id: botId, control_connected: channel.connected });
});

const controlWss = new WebSocketServer({ noServer: true });
controlWss.on("connection", (ws) => channel.attach(ws));

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
  } else {
    socket.destroy();
  }
});

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log.banner("MeetStream Labs: WebSocket Bot Control", "socket_connection_url, your own bridge");

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, resolve);
  });
  log.info(`Local server on port ${c("green", PORT)}`);

  const tunnel = await resolvePublicUrl(PORT);
  const controlUrl = `${toWss(tunnel.url)}/control`;
  log.info(`Public URL (${tunnel.source}): ${c("cyan", tunnel.url)}`);
  log.detail(`socket_connection_url = ${controlUrl}`);

  const client = new MeetStreamClient(process.env.MEETSTREAM_API_KEY, { logger: log });

  log.info("Creating bot…");
  const bot = await client.createBot({
    meeting_link: process.env.MEETING_LINK,
    bot_name: BOT_NAME,
    video_required: false,
    callback_url: `${tunnel.url}/webhook`,

    // The control channel.
    socket_connection_url: { websocket_url: controlUrl },

    automatic_leave: {
      waiting_room_timeout: 600,
      everyone_left_timeout: 60,
      in_call_recording_timeout: 14400, // minimum accepted value is 600
    },
  });

  botId = bot.bot_id;
  log.success(`Bot created: ${c("bold", botId)} (status: ${bot.status})`);
  log.info("Waiting for the bot to join and open the control channel…");

  channel.onReady = () => {
    if (GREETING) {
      try {
        channel.sendMsg(GREETING);
        log.success(`Greeting sent: "${GREETING}"`);
      } catch (err) {
        log.error("Greeting failed", err);
      }
    }
  };

  channel.onClose = () => {
    log.warn("The bot has left. Commands will fail until another bot connects.");
  };

  // ── Shutdown ────────────────────────────────────────────────────────────────
  let shuttingDown = false;
  async function shutdown(reason, code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("");
    log.info(`Shutting down (${reason})…`);

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

  startRepl(channel, { onQuit: () => shutdown("quit") });
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
