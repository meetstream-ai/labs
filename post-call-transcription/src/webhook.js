const express = require("express");
const crypto = require("crypto");
const { fetchTranscript, resolveTranscriptId } = require("./transcript");
const state = require("./state");

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

    // Acknowledge immediately - MeetStream does not retry a delivery.
    res.status(200).json({ received: true });

    Promise.resolve(handleEvent(req.body)).catch((err) => {
      console.error(`  Webhook handling failed: ${err.message}`);
    });
  });

  app.get("/health", (_req, res) => res.json({ status: "ok", bot_id: state.botId }));

  const server = app.listen(port, () => {
    console.log(`  Webhook server listening on port ${port}`);
    console.log(`   POST /webhook  ->  receives MeetStream events`);
    console.log(`   GET  /health   ->  liveness check\n`);
    if (onReady) onReady();
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`  Port ${port} is already in use. Stop the other process or set PORT in .env.`);
    } else {
      console.error(`  Webhook server failed to start: ${err.message}`);
    }
    process.exit(1);
  });

  return server;
}

/**
 * Every delivery carries `event`; most also carry `bot_event` with the
 * specific name. On `bot.stopped`, `bot_event` is the reason for the stop.
 * `bot.done` is the final event on every path.
 */
async function handleEvent(payload) {
  const { event, bot_id } = payload || {};
  if (!event) {
    console.log("  Ignored a webhook without an `event` key.");
    return;
  }
  const name = payload.bot_event ?? event;

  switch (event) {
    case "bot.joining":
      console.log(`  [${bot_id}] Bot is joining the meeting...`);
      break;
    case "bot.in_waiting_room":
      console.log(`  [${bot_id}] Bot is in the waiting room - someone needs to admit it.`);
      break;
    case "bot.inmeeting":
      console.log(`  [${bot_id}] Bot is IN the meeting.`);
      break;
    case "bot.recording":
      console.log(`  [${bot_id}] Recording started.`);
      break;
    case "bot.leaving":
      console.log(`  [${bot_id}] Bot is leaving the meeting.`);
      break;
    case "bot.stopped":
      handleBotStopped(payload);
      break;
    case "bot.error":
      // Non-terminal: a streaming-provider hiccup. The bot keeps running.
      console.warn(`  [${bot_id}] Non-fatal bot.error: ${payload.message ?? "no message"} (the bot keeps running)`);
      break;
    case "manifest.completed":
    case "audio.processed":
    case "video.processed":
    case "bot.transcriptionready":
      console.log(`  [${bot_id}] ${name}`);
      break;
    case "transcription.processed":
      await handleTranscriptionReady(payload);
      break;
    case "transcription.failed":
      console.error(`  [${bot_id}] Transcription failed: ${payload.message ?? "no message"}`);
      state.transcriptFailed = true;
      break;
    case "bot.done":
      handleBotDone(payload);
      break;
    default:
      console.log(`  [${bot_id ?? "?"}] Event: ${name}`);
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
  const { bot_id, bot_status, status_code, message } = payload;
  const reason = stopReason(payload);
  // status_code is 200 for a clean exit or a kick, 500 for notallowed / denied
  // and usually for failed. Branch on the reason, not the code.
  console.log(
    `  [${bot_id}] Bot stopped - reason: ${reason} (bot_status: ${bot_status ?? "?"}, status_code: ${status_code ?? "?"})`
  );
  if (message) console.log(`   ${message}`);

  if (reason === "bot.stopped" || reason === "bot.kicked") {
    console.log("   Waiting for transcription.processed...\n");
  } else if (reason === "bot.notallowed" || reason === "bot.denied") {
    console.error(
      "   Nothing was recorded (never admitted from the waiting room / host refused). No transcript will exist.\n"
    );
    process.exit(1);
  } else {
    console.warn("   The bot failed mid-meeting. Partial media may still be processed; waiting for bot.done.\n");
  }
}

async function handleTranscriptionReady(payload) {
  const { bot_id, transcript_status } = payload;
  if (transcript_status && !/success/i.test(String(transcript_status))) {
    console.warn(`   [${bot_id}] Transcription status: ${transcript_status}. Skipping fetch.`);
    return;
  }
  if (state.fetching) return;
  state.fetching = true;

  console.log(`   [${bot_id}] Transcription is ready!`);

  // transcript_id is never in a webhook. Use the one from create_bot, or look it up.
  let transcriptId = state.transcriptId;
  if (!transcriptId) {
    console.log("   create_bot did not return a transcript_id - looking it up on GET /bots/{id}/detail...");
    transcriptId = await resolveTranscriptId(bot_id || state.botId);
  }
  if (!transcriptId) {
    console.error("   Could not determine transcript_id. Check GET /bots/{id}/transcriptions.");
    process.exit(1);
  }

  const saved = await fetchTranscript(transcriptId);
  state.fetching = false;
  process.exit(saved ? 0 : 1);
}

function handleBotDone({ bot_id }) {
  // bot.done is the final event on every path. If a fetch is in progress the
  // transcript arrived and we are just polling; otherwise none is coming.
  if (state.fetching) return;
  if (state.transcriptFailed) {
    console.error(`  [${bot_id}] Session finished after transcription.failed - no transcript.`);
  } else {
    console.error(
      `  [${bot_id}] bot.done arrived without transcription.processed - there is no post-call transcript for this session.`
    );
  }
  process.exit(1);
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

module.exports = { startWebhookServer, handleEvent, stopReason };
