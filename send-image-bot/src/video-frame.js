/**
 * Video-frame mode: set the bot's camera feed to an image.
 *
 * This is a different thing from POST /bots/{id}/send_image:
 *
 *   send_image (REST)        posts a picture into the meeting CHAT
 *   sendimg / sendimg_url    replaces the bot's outgoing VIDEO with a still image
 *
 * The two sendimg commands travel over the control channel, which only exists if
 * the bot was created with `socket_connection_url: { websocket_url }` pointing at
 * a WebSocket server you run. That is why this mode creates its own bot rather
 * than accepting a --bot-id: an already-running bot has no socket to talk on.
 *
 * Sequence:
 *   1. start a local WS server
 *   2. resolve a public wss:// URL for it
 *   3. create_bot with socket_connection_url
 *   4. bot joins, connects back, sends { type: "ready", bot_id, message }
 *   5. we send sendimg_url (public URL) or sendimg (base64 of a local file)
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { WebSocketServer } from "ws";

import { log, c } from "./logger.js";
import { resolvePublicUrl, toWss } from "./tunnel.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/**
 * @param {import("./meetstream.js").MeetStreamClient} client
 * @param {{ meetingLink: string, botName: string, imgUrls: string[], imgFile: string|null,
 *           interval: number, duration: number|null, port: number }} options
 */
export async function runVideoFrameMode(client, options) {
  const { meetingLink, botName, imgUrls, imgFile, interval, duration, port } = options;

  // Read and encode the local file up front so a bad path fails before a bot
  // is ever created.
  let base64Image = null;
  if (imgFile) {
    const ext = extname(imgFile).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      log.warn(`${imgFile} does not look like an image (${ext || "no extension"}): sending it anyway.`);
    }
    const bytes = readFileSync(imgFile);
    base64Image = bytes.toString("base64");
    log.info(`Loaded ${imgFile} (${(bytes.length / 1024).toFixed(1)} KB) for the sendimg command`);
  }

  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname === "/control") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, resolve);
  });
  log.info(`Control server on port ${c("green", port)}`);

  const tunnel = await resolvePublicUrl(port);
  const controlUrl = `${toWss(tunnel.url)}/control`;
  log.info(`Public URL (${tunnel.source}): ${c("cyan", tunnel.url)}`);
  log.detail(`socket_connection_url = ${controlUrl}`);

  let botId = null;
  let slideshow = null;
  let stopTimer = null;
  let finished = false;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  wss.on("connection", (ws) => {
    log.success("Bot connected to the control socket");

    ws.on("message", (data, isBinary) => {
      if (isBinary) return; // the control channel is JSON text only

      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        log.warn("Ignoring non-JSON control frame");
        return;
      }

      if (msg.type !== "ready") {
        log.detail(`Control message: ${JSON.stringify(msg)}`);
        return;
      }

      // Handshake: { type: "ready", bot_id, message }
      const readyBotId = msg.bot_id ?? botId;
      log.success(`Handshake received: bot ${readyBotId} is ready for commands`);

      const send = (payload) => {
        try {
          ws.send(JSON.stringify({ ...payload, bot_id: readyBotId }));
          return true;
        } catch (err) {
          log.error("Failed to write to the control socket", err);
          return false;
        }
      };

      if (base64Image) {
        // sendimg: base64 image bytes, no hosting required
        if (send({ command: "sendimg", img: base64Image })) {
          log.success(`sendimg sent (${(base64Image.length / 1024).toFixed(1)} KB base64)`);
        }
      }

      if (imgUrls.length === 1) {
        if (send({ command: "sendimg_url", img_url: imgUrls[0] })) {
          log.success(`sendimg_url sent → ${imgUrls[0]}`);
        }
      } else if (imgUrls.length > 1) {
        let index = 0;
        const advance = () => {
          const url = imgUrls[index % imgUrls.length];
          if (send({ command: "sendimg_url", img_url: url })) {
            log.success(`sendimg_url [${(index % imgUrls.length) + 1}/${imgUrls.length}] → ${url}`);
          }
          index++;
        };
        advance();
        slideshow = setInterval(advance, interval * 1000);
        log.info(`Slideshow running: ${imgUrls.length} frames every ${interval}s`);
      }
    });

    ws.on("close", (code) => {
      log.info(`Control socket closed (code ${code})`);
      finish();
    });

    ws.on("error", (err) => log.error("Control socket error", err));
  });

  log.info(`Creating a bot for ${meetingLink} …`);
  const bot = await client.createBot({
    meeting_link: meetingLink,
    bot_name: botName,
    video_required: false,

    // The control channel. This points at OUR WebSocket server: it is a
    // bring-your-own bridge, and is unrelated to MIA (MIA takes only
    // agent_config_id and never these fields).
    socket_connection_url: { websocket_url: controlUrl },

    automatic_leave: {
      waiting_room_timeout: 600,
      everyone_left_timeout: 60,
      in_call_recording_timeout: 14400, // minimum accepted value is 600
    },
  });

  botId = bot.bot_id;
  log.success(`Bot created: ${c("bold", botId)} (status: ${bot.status})`);
  log.info("Waiting for the bot to join and open the control socket…");
  log.detail("Press Ctrl+C to remove the bot and exit.");

  if (duration) {
    stopTimer = setTimeout(() => {
      log.info(`--duration ${duration}s reached.`);
      finish();
    }, duration * 1000);
  }

  async function finish() {
    if (finished) return;
    finished = true;

    if (slideshow) clearInterval(slideshow);
    if (stopTimer) clearTimeout(stopTimer);

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
    resolveDone();
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      console.log("");
      log.info(`Received ${signal}: cleaning up…`);
      void finish();
    });
  }

  await done;
}
