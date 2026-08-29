/**
 * A webhook listener that logs every MeetStream lifecycle event and calls out
 * `data_deletion` in particular.
 *
 * Remember: webhooks are delivered to the `callback_url` you set when the bot
 * was created. There is no global webhook endpoint and no way to attach a URL
 * to a bot after the fact, so the bot you delete must already point here.
 */

import express from "express";

/** The envelope key is `event`. Any doc that says `bot_event` is wrong. */
function summarise(payload) {
  const { event, bot_id, bot_status, message, status_code } = payload ?? {};
  return {
    event: event ?? "(missing `event` key)",
    botId: bot_id ?? "?",
    botStatus: bot_status ?? null,
    message: message ?? null,
    statusCode: status_code ?? null,
  };
}

export function startWebhookServer(port, { onDataDeletion } = {}) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.post("/webhook", (req, res) => {
    // Acknowledge first. Slow handlers look like failed deliveries.
    res.status(200).json({ received: true });

    const { event, botId, botStatus, message, statusCode } = summarise(req.body);
    const stamp = new Date().toISOString();

    if (event === "data_deletion") {
      console.log("\n" + "=".repeat(68));
      console.log(`[${stamp}] data_deletion`);
      console.log(`  bot_id      : ${botId}`);
      console.log(`  status_code : ${statusCode ?? "-"}`);
      console.log(`  message     : ${message ?? "-"}`);
      console.log("");
      console.log("  The audio, video and transcripts for this bot are gone.");
      console.log("  This is the point of no return. Nothing restores them.");
      console.log("=".repeat(68) + "\n");
      console.log("Full payload:");
      console.log(JSON.stringify(req.body, null, 2) + "\n");
      if (onDataDeletion) onDataDeletion(req.body);
      return;
    }

    const suffix = botStatus ? ` (bot_status: ${botStatus})` : "";
    console.log(`[${stamp}] ${event}${suffix}  bot_id=${botId}`);
    if (message) console.log(`            ${message}`);
  });

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  const server = app.listen(port, () => {
    console.log(`Webhook listener on http://localhost:${port}`);
    console.log("  POST /webhook   receives MeetStream events");
    console.log("  GET  /health    liveness check");
    console.log("");
    console.log("Expose this publicly (ngrok, Cloudflare Tunnel, a deployed host) and");
    console.log("pass the public /webhook URL as callback_url when you create a bot.");
    console.log("Waiting for events. Ctrl+C to stop.\n");
  });

  return server;
}
