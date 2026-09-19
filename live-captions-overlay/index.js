/**
 * MeetStream Labs - live-captions-overlay
 *
 * Live captions in your terminal while a meeting is happening.
 *
 *   live_transcription_required.webhook_url  ──►  POST /live
 *   callback_url                             ──►  POST /webhook
 *
 * Two hard rules this template exists to teach:
 *
 *   1. live_transcription_required REQUIRES a *_streaming provider.
 *      Pairing it with a post-call provider is an HTTP 400.
 *   2. A streaming-only bot produces NO post-call transcript. It never fires
 *      transcription.processed, and GET /transcript/{id}/get_transcript
 *      returns 202 forever. Its lifecycle still ends with `bot.done`, like
 *      every other bot.
 *
 * Usage:
 *   PUBLIC_URL=https://<your-tunnel> node index.js <meeting_link>
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";

import { MeetStreamError, api, requireApiKey } from "./src/client.js";
import { assertStreamingProvider, buildProviderBlock } from "./src/providers.js";
import { CaptionOverlay } from "./src/captions.js";
import { normalizeChunk, startServer } from "./src/server.js";

const PROVIDER = (process.env.PROVIDER || "deepgram_streaming").trim();
const LANGUAGE = (process.env.LANGUAGE || "").trim();
const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
const BOT_NAME = process.env.BOT_NAME || "MeetStream Captions Bot";
const CAPTION_LINES = Number.parseInt(process.env.CAPTION_LINES ?? "10", 10);
const RETENTION_HOURS = Number.parseInt(process.env.RETENTION_HOURS ?? "24", 10);
const REMOVE_BOT_ON_EXIT = process.env.REMOVE_BOT_ON_EXIT !== "false";

const overlay = new CaptionOverlay({ maxLines: CAPTION_LINES });
let activeBotId = null;
let shuttingDown = false;

function handleCaption(rawChunk) {
  const chunk = normalizeChunk(rawChunk);
  if (!chunk.text) return;
  overlay.push(chunk);
}

function handleLifecycle(payload) {
  // `event` is always present. `bot_event` carries the specific name and, on
  // terminals, the reason (event "bot.stopped", bot_event "bot.kicked", ...).
  const { event, bot_id: botId, bot_status: botStatus, message, status_code: statusCode } = payload;
  const name = payload.bot_event ?? event;

  switch (event) {
    case "bot.joining":
      overlay.setStatus("bot is joining the meeting");
      break;
    case "bot.in_waiting_room":
      overlay.setStatus("bot is in the waiting room - admit it to start captions");
      break;
    case "bot.inmeeting":
      overlay.setStatus("bot is in the meeting");
      break;
    case "bot.recording":
      overlay.setStatus("recording - captions will appear as people speak");
      break;
    case "bot.error":
      // Non-terminal: a streaming provider hiccuped, the bot keeps running.
      overlay.note(`streaming provider error (bot still running): ${message ?? "no detail"}`);
      break;
    case "bot.leaving":
      overlay.setStatus("bot is leaving");
      break;
    case "bot.stopped": {
      // Every ending arrives as event "bot.stopped". The reason is in
      // bot_event; status_code is 200 for a clean exit or kick, 500 for
      // notallowed / denied and usually 500 for failed.
      const reason = terminalReason(payload);
      overlay.setStatus(`bot stopped (${reason}${statusCode ? `, ${statusCode}` : ""})`);
      overlay.note(explainStop(reason, message));
      break;
    }
    case "audio.processed":
      overlay.note(
        "audio.processed - the recording is saved. A streaming-only bot gets no " +
          "transcription.processed; bot.done follows when the session is finished.",
      );
      break;
    case "bot.done":
      overlay.setStatus("finished (streaming-only bot: no post-call transcript)");
      break;
    default:
      overlay.note(
        `event: ${name ?? "?"}${botStatus ? ` (${botStatus})` : ""}` +
          `${statusCode ? ` [${statusCode}]` : ""}${botId ? ` bot=${botId}` : ""}`,
      );
  }
}

/**
 * The reason a bot ended. `bot_event` is authoritative; when it is missing,
 * fall back to bot_status compared case-insensitively. Do not branch on
 * bot_status alone: a kick and a clean exit both report "Stopped".
 */
function terminalReason(payload) {
  if (payload.bot_event) return payload.bot_event;
  const status = String(payload.bot_status ?? "").toLowerCase();
  if (status === "notallowed") return "bot.notallowed";
  if (status === "denied") return "bot.denied";
  if (status === "error" || status === "failed") return "bot.failed";
  return "bot.stopped";
}

function explainStop(reason, message) {
  switch (reason) {
    case "bot.stopped":
      return "Clean exit. The meeting ended or the bot was stopped.";
    case "bot.kicked":
      return "A participant removed the bot from the meeting.";
    case "bot.notallowed":
      return "The bot was never admitted from the waiting room.";
    case "bot.denied":
      return "The host denied the join request.";
    case "bot.failed":
      return `The bot failed: ${message ?? "no detail"}`;
    default:
      return message ?? "Bot stopped.";
  }
}

async function createCaptionBot(meetingLink) {
  const payload = {
    meeting_link: meetingLink,
    bot_name: BOT_NAME,
    video_required: false,

    // Where live transcript chunks are POSTed.
    live_transcription_required: { webhook_url: `${PUBLIC_URL}/live` },

    // Where lifecycle events are POSTed.
    callback_url: `${PUBLIC_URL}/webhook`,

    recording_config: {
      transcript: {
        provider: buildProviderBlock(PROVIDER, { language: LANGUAGE || undefined }),
      },
      retention: { type: "timed", hours: RETENTION_HOURS },
    },

    custom_attributes: {
      // Values must be strings. Echoed back in every webhook.
      template: "live-captions-overlay",
      provider: PROVIDER,
    },
  };

  const { status, data } = await api("/bots/create_bot", {
    method: "POST",
    body: payload,
    headers: { "Idempotency-Key": randomUUID() },
  });

  if (status === 507) {
    console.log("HTTP 507 - idempotent replay, returning the original bot. Not an error.");
  }
  return data;
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (activeBotId && REMOVE_BOT_ON_EXIT) {
    try {
      // Note: remove_bot is a GET, not a POST or DELETE.
      await api(`/bots/${encodeURIComponent(activeBotId)}/remove_bot`);
      console.log(`\nRemoved bot ${activeBotId} from the meeting.`);
    } catch (err) {
      console.error(`\nCould not remove bot ${activeBotId}: ${err.message}`);
    }
  } else if (activeBotId) {
    console.log(`\nBot ${activeBotId} is still in the meeting.`);
    console.log(`Remove it with: GET /bots/${activeBotId}/remove_bot`);
  }

  process.exit(code);
}

function printUsage() {
  console.log(
    [
      "Usage: node index.js <meeting_link>",
      "",
      "Live captions in the terminal from a MeetStream bot with live_transcription_required.",
      "Needs MEETSTREAM_API_KEY and PUBLIC_URL (a public https tunnel to this machine) in .env.",
      "The meeting link can also come from MEETING_LINK. See .env.example for every option.",
    ].join("\n"),
  );
}

async function main() {
  const arg = process.argv[2];
  if (arg === "--help" || arg === "-h" || arg === "help") {
    printUsage();
    return;
  }

  requireApiKey();

  const meetingLink = arg || process.env.MEETING_LINK || "";
  if (!meetingLink) {
    console.error("Provide a meeting link: `node index.js <meeting_link>` or set MEETING_LINK.");
    process.exit(1);
  }

  if (!Number.isInteger(PORT) || PORT <= 0) {
    console.error(`PORT must be a positive integer. Got: ${process.env.PORT}`);
    process.exit(1);
  }

  if (!PUBLIC_URL) {
    console.error("PUBLIC_URL is not set.");
    console.error("MeetStream must be able to reach this machine over HTTPS. Start a tunnel");
    console.error(`(for example: ngrok http ${PORT}) and set PUBLIC_URL to the public URL.`);
    process.exit(1);
  }
  if (!PUBLIC_URL.startsWith("https://")) {
    console.error(`PUBLIC_URL must be an https:// URL. Got: ${PUBLIC_URL}`);
    process.exit(1);
  }

  // Fail before the API does, with an explanation.
  assertStreamingProvider(PROVIDER);

  console.log(`Provider   : ${PROVIDER}`);
  console.log(`Meeting    : ${meetingLink}`);
  console.log(`Captions   : POST ${PUBLIC_URL}/live`);
  console.log(`Lifecycle  : POST ${PUBLIC_URL}/webhook`);
  console.log(`Local port : ${PORT}\n`);

  // ── Start the receiver before the bot exists ───────────────────────────────
  await new Promise((resolve) => {
    startServer({
      port: PORT,
      onCaption: handleCaption,
      onLifecycle: handleLifecycle,
      onReady: () => {
        console.log(`Listening on :${PORT} (POST /live, POST /webhook, GET /health)`);
        resolve();
      },
    });
  });

  // ── Send the bot ───────────────────────────────────────────────────────────
  console.log("POST /bots/create_bot");
  const data = await createCaptionBot(meetingLink);

  activeBotId = data?.bot_id ?? null;
  if (!activeBotId) throw new Error(`create_bot did not return a bot_id: ${JSON.stringify(data)}`);

  console.log(`bot_id        : ${activeBotId}`);
  console.log(
    `transcript_id : ${data?.transcript_id ?? "null"} ` +
      "(streaming-only bots have no post-call transcript)",
  );

  overlay.setStatus(`bot ${activeBotId} dispatched`);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

main().catch((err) => {
  if (err instanceof MeetStreamError) {
    console.error(`\nMeetStream API error: ${err.message}`);
    if (err.status === 400) {
      console.error(
        "\nA 400 with live_transcription_required almost always means the provider is\n" +
          "not a streaming one. live_transcription_required requires a *_streaming\n" +
          "provider under recording_config.transcript.provider.",
      );
    }
    if (err.body) console.error(JSON.stringify(err.body, null, 2));
  } else {
    console.error(`\n${err.message}`);
  }
  process.exit(1);
});
