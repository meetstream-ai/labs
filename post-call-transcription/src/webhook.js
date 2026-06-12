const express = require("express");
const crypto = require("crypto");
const { fetchTranscript } = require("./transcript");

const PORT = process.env.PORT || 3000;

/**
 * Starts a lightweight Express server that listens for MeetStream webhook events.
 *
 * Key events handled:
 *   bot.joining          → log
 *   bot.inmeeting        → log (recording is live)
 *   bot.stopped          → log terminal status; wait for transcription.processed
 *   transcription.processed → fetch + display the full transcript
 *   audio.processed      → log
 *   video.processed      → log
 *
 * @param {Function} [onReady]  Called once the server is listening
 */
function startWebhookServer(onReady) {
  const app = express();

  // Raw body needed for HMAC signature verification
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  app.post("/webhook", (req, res) => {
    // ── 1) Verify signature (if WEBHOOK_SECRET is configured) ──────────────
    if (process.env.WEBHOOK_SECRET) {
      if (!verifySignature(req)) {
        console.warn("   Webhook signature mismatch — request rejected.");
        return res.status(401).json({ error: "Invalid signature" });
      }
    }

    // ── 2) Acknowledge immediately (MeetStream does not retry on non-2xx) ──
    res.status(200).json({ received: true });

    // ── 3) Handle the event ────────────────────────────────────────────────
    const payload = req.body;
    handleEvent(payload);
  });

  // Health-check endpoint — useful when running behind ngrok
  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.listen(PORT, () => {
    console.log(`  Webhook server listening on port ${PORT}`);
    console.log(`   POST /webhook  →  receives MeetStream events`);
    console.log(`   GET  /health   →  liveness check\n`);
    if (onReady) onReady();
  });
}

/**
 * Routes a webhook payload to the right handler.
 */
function handleEvent(payload) {
  const { event, bot_id, bot_status, message } = payload;

  switch (event) {
    case "bot.joining":
      console.log(`  [${bot_id}] Bot is joining the meeting…`);
      break;

    case "bot.inmeeting":
      console.log(`  [${bot_id}] Bot is IN the meeting — recording started.`);
      break;

    case "bot.stopped":
      handleBotStopped(payload);
      break;

    case "audio.processed":
      console.log(`  [${bot_id}] Audio processing complete.`);
      break;

    case "transcription.processed":
      handleTranscriptionReady(payload);
      break;

    case "video.processed":
      console.log(`  [${bot_id}] Video processing complete.`);
      break;

    case "data_deletion":
      console.log(`   [${bot_id}] Bot data deleted by MeetStream.`);
      break;

    default:
      console.log(`ℹ   [${bot_id ?? "?"}] Unknown event: ${event}`);
      console.log("   Payload:", JSON.stringify(payload, null, 2));
  }
}

function handleBotStopped({ bot_id, bot_status, message }) {
  const statusEmoji = {
    Stopped: " ",
    NotAllowed: " ",
    Denied: " ",
    Error: " ",
  };

  const emoji = statusEmoji[bot_status] ?? "⏹️";
  console.log(`${emoji}  [${bot_id}] Bot stopped — status: ${bot_status}`);

  if (message) {
    console.log(`   Reason: ${message}`);
  }

  if (bot_status === "Stopped") {
    console.log(
      "   Waiting for transcription.processed event before fetching transcript…\n"
    );
  } else {
    console.log("   Bot did not complete normally — no transcript to fetch.\n");
  }
}

function handleTranscriptionReady({ bot_id, transcript_status }) {
  if (transcript_status !== "Success") {
    console.warn(
      `   [${bot_id}] Transcription status: ${transcript_status}. Skipping fetch.`
    );
    return;
  }

  console.log(`  [${bot_id}] Transcription is ready!`);

  // Prefer the transcript_id stored when the bot was created.
  // MeetStream may also echo it in the webhook payload.
  const transcriptId = process.env._TRANSCRIPT_ID || null;
  fetchTranscript(transcriptId);
}

/**
 * Verifies HMAC-SHA256 webhook signature.
 * Header: X-MeetStream-Signature: sha256=<hex>
 */
function verifySignature(req) {
  const sigHeader = req.headers["x-meetstream-signature"] ?? "";
  const expected = sigHeader.replace(/^sha256=/, "");

  const hmac = crypto
    .createHmac("sha256", process.env.WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(hmac, "hex"),
      Buffer.from(expected, "hex")
    );
  } catch {
    return false;
  }
}

module.exports = { startWebhookServer };
