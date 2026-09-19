const express = require("express");
const crypto = require("crypto");
const { fetchTranscript } = require("./transcript");

/**
 * Starts a lightweight Express server that listens for MeetStream webhook events.
 *
 * @param {number}   port      Port to listen on
 * @param {Function} onReady   Called once the server is listening
 */
function startWebhookServer(port, onReady) {
  const app = express();

  app.use(
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  app.post("/webhook", (req, res) => {
    if (process.env.WEBHOOK_SECRET) {
      if (!verifySignature(req)) {
        console.warn("   Webhook signature mismatch - request rejected.");
        return res.status(401).json({ error: "Invalid signature" });
      }
    }

    // Acknowledge immediately - MeetStream does not retry on non-2xx
    res.status(200).json({ received: true });

    handleEvent(req.body);
  });

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.listen(port, () => {
    console.log(`  Webhook server listening on port ${port}`);
    console.log(`   POST /webhook  →  receives MeetStream events`);
    console.log(`   GET  /health   →  liveness check\n`);
    if (onReady) onReady();
  });
}

function handleEvent(payload) {
  const { event, bot_id } = payload;

  switch (event) {
    case "bot.joining":
      console.log(`  [${bot_id}] Bot is joining the meeting…`);
      break;
    case "bot.inmeeting":
      console.log(`  [${bot_id}] Bot is IN the meeting - recording started.`);
      break;
    case "bot.stopped":
      handleBotStopped(payload);
      break;
    case "audio.processed":
      console.log(`🎵  [${bot_id}] Audio processing complete.`);
      break;
    case "transcription.processed":
      handleTranscriptionReady(payload);
      break;
    case "video.processed":
      console.log(`  [${bot_id}] Video processing complete.`);
      break;
    default:
      console.log(`ℹ   [${bot_id ?? "?"}] Event: ${event}`);
  }
}

/**
 * Every ending arrives once as event "bot.stopped"; the reason is in bot_event
 * (bot.stopped | bot.kicked | bot.notallowed | bot.denied | bot.failed).
 * bot_status is only a case-insensitive fallback: a kick and a clean exit both
 * say "Stopped", and failure casing varies (FAILED / ERROR / Failed).
 */
function stopReason(payload) {
  if (payload.bot_event) return payload.bot_event;
  const status = String(payload.bot_status ?? "").toLowerCase();
  if (status === "notallowed") return "bot.notallowed";
  if (status === "denied") return "bot.denied";
  if (status === "error" || status === "failed") return "bot.failed";
  return "bot.stopped";
}

function handleBotStopped(payload) {
  const { bot_id, bot_status, message } = payload;
  const reason = stopReason(payload);
  console.log(`   [${bot_id}] Bot stopped - reason: ${reason} (status: ${bot_status})`);
  if (message) console.log(`   Reason: ${message}`);
  if (reason === "bot.stopped" || reason === "bot.kicked") {
    console.log("   Waiting for transcription.processed event…\n");
  } else {
    console.log("   Bot did not complete normally - no transcript to fetch.\n");
  }
}

function handleTranscriptionReady({ bot_id, transcript_status }) {
  if (transcript_status !== "Success") {
    console.warn(`    [${bot_id}] Transcription status: ${transcript_status}. Skipping fetch.`);
    return;
  }
  console.log(`   [${bot_id}] Transcription is ready!`);
  fetchTranscript(process.env._TRANSCRIPT_ID || null);
}

function verifySignature(req) {
  const sigHeader = req.headers["x-meetstream-signature"] ?? "";
  const expected = sigHeader.replace(/^sha256=/, "");
  const hmac = crypto
    .createHmac("sha256", process.env.WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

module.exports = { startWebhookServer };
