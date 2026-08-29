/**
 * Shared runner for the "MeetStream + another tool" templates.
 *
 * It gives every template the same two ways to run:
 *
 *   LIVE MODE   node index.js --meeting "https://meet.google.com/abc-defg-hij"
 *               Creates a bot, serves a webhook, waits for `transcription.processed`,
 *               fetches the transcript by transcript_id, then calls your handler.
 *
 *   REPLAY MODE node index.js --bot <bot_id>
 *               node index.js --transcript <transcript_id>
 *               Skips the bot + webhook entirely and runs your handler against a
 *               meeting that already finished. This is the fast way to iterate.
 *
 * The MeetStream lifecycle it follows is the real one:
 *   bot.joining → bot.in_waiting_room → bot.inmeeting → bot.recording → bot.leaving
 *   → bot.stopped → manifest.completed → audio.processed → transcription.processed
 *   → video.processed → bot.done → data_deletion
 *
 * Note: webhooks never carry `transcript_id`. We take it from the create_bot
 * response (and fall back to /bots/{id}/detail or /bots/{id}/transcriptions).
 */

import express from "express";
import {
  createBot,
  buildTranscriptProvider,
  extractSegments,
  getBotDetail,
  listTranscriptions,
  requireEnv,
  waitForTranscript,
} from "./meetstream.js";

/** Parse `--flag value` / `--flag=value` argv. */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq !== -1) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[token.slice(2)] = next;
        i++;
      } else {
        args[token.slice(2)] = true;
      }
    }
  }
  return args;
}

/**
 * @typedef {object} MeetingResult
 * @property {string|null} botId
 * @property {string} transcriptId
 * @property {any} transcript                 Raw get_transcript payload
 * @property {Array<object>} segments         Normalised `{ speaker, transcript, ... }`
 */

/**
 * @param {object} options
 * @param {string} options.name                          Template name, for logging
 * @param {(result: MeetingResult) => Promise<void>} options.onMeetingComplete
 * @param {() => void} [options.preflight]               Validate template-specific env up front
 */
export async function run({ name, onMeetingComplete, preflight }) {
  const args = parseArgs();

  console.log(`\n=== MeetStream Labs · ${name} ===\n`);

  if (args.help) {
    printUsage();
    return;
  }

  // Fail fast on config before we touch any network.
  requireEnv("MEETSTREAM_API_KEY", "Create one at https://app.meetstream.ai under API Keys.");
  if (preflight) preflight();

  const transcriptId = args.transcript || process.env.TRANSCRIPT_ID;
  const botId = args.bot || process.env.BOT_ID;

  if (transcriptId || botId) {
    await replayMode({ botId, transcriptId, onMeetingComplete });
    return;
  }

  await liveMode({ args, onMeetingComplete });
}

/* ------------------------------------------------------------------ */
/* Replay mode                                                         */
/* ------------------------------------------------------------------ */

async function replayMode({ botId, transcriptId, onMeetingComplete }) {
  let resolvedTranscriptId = transcriptId;

  if (!resolvedTranscriptId) {
    console.log(`Looking up the transcript_id for bot ${botId}...`);
    resolvedTranscriptId = await resolveTranscriptId(botId);
    if (!resolvedTranscriptId) {
      console.error(
        `\n  No transcript_id found for bot ${botId}.\n` +
          `  This happens when the bot used a streaming-only transcription provider\n` +
          `  (those return transcript_id: null and never produce a post-call transcript).\n`
      );
      process.exit(1);
    }
    console.log(`Found transcript_id: ${resolvedTranscriptId}`);
  }

  await finish({ botId: botId || null, transcriptId: resolvedTranscriptId, onMeetingComplete });
}

/** transcript_id is never in the webhook payload - look it up on the bot instead. */
export async function resolveTranscriptId(botId) {
  if (!botId) return null;

  // 401 (no key) and 403 (bad key) are config problems, not "no transcript".
  // Let them bubble up so the user sees the real cause.
  const rethrowAuthErrors = (error) => {
    if (error.status === 401 || error.status === 403) throw error;
  };

  try {
    const detail = await getBotDetail(botId);
    const fromDetail = findTranscriptId(detail);
    if (fromDetail) return fromDetail;
  } catch (error) {
    rethrowAuthErrors(error);
    console.warn(`  /bots/${botId}/detail failed: ${error.message}`);
  }

  try {
    const transcriptions = await listTranscriptions(botId);
    const fromList = findTranscriptId(transcriptions);
    if (fromList) return fromList;
  } catch (error) {
    rethrowAuthErrors(error);
    console.warn(`  /bots/${botId}/transcriptions failed: ${error.message}`);
  }

  return null;
}

function findTranscriptId(payload, depth = 0) {
  if (!payload || depth > 4) return null;
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const found = findTranscriptId(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof payload !== "object") return null;
  if (typeof payload.transcript_id === "string" && payload.transcript_id) return payload.transcript_id;
  for (const value of Object.values(payload)) {
    const found = findTranscriptId(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Live mode                                                           */
/* ------------------------------------------------------------------ */

async function liveMode({ args, onMeetingComplete }) {
  const meetingLink = args.meeting || process.env.MEETING_LINK;
  if (!meetingLink) {
    console.error("  No meeting to join and no bot/transcript to replay.\n");
    printUsage();
    process.exit(1);
  }

  const publicBaseUrl = (args["public-url"] || process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (!publicBaseUrl) {
    console.error(
      "\n  PUBLIC_BASE_URL is required in live mode - MeetStream has to reach your webhook.\n" +
        "  Start a tunnel in another terminal, e.g.:\n" +
        "      ngrok http 3000            (then copy the https URL)\n" +
        "      cloudflared tunnel --url http://localhost:3000\n" +
        "  and set PUBLIC_BASE_URL to it.\n"
    );
    process.exit(1);
  }

  const port = Number(args.port || process.env.PORT || 3000);
  const provider = process.env.TRANSCRIPT_PROVIDER || "meetstream";
  const language = process.env.TRANSCRIPT_LANGUAGE || "en";

  const state = { transcriptId: null, botId: null, done: false };

  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => res.json({ status: "ok", bot_id: state.botId }));

  app.post("/webhook", (req, res) => {
    // Acknowledge first - never make MeetStream wait on your processing.
    res.status(200).json({ received: true });
    handleWebhookEvent(req.body, state, onMeetingComplete).catch((error) => {
      console.error(`  Webhook handling failed: ${error.message}`);
    });
  });

  await new Promise((resolve) => app.listen(port, resolve));
  console.log(`Webhook server listening on http://localhost:${port}`);
  console.log(`Public callback_url: ${publicBaseUrl}/webhook\n`);

  const bot = await createBot({
    meetingLink,
    botName: process.env.BOT_NAME || "MeetStream Labs Bot",
    callbackUrl: `${publicBaseUrl}/webhook`,
    videoRequired: false,
    transcriptProvider: buildTranscriptProvider(provider, language),
    retentionHours: process.env.RETENTION_HOURS ? Number(process.env.RETENTION_HOURS) : undefined,
    idempotencyKey: randomUuid(),
  });

  state.botId = bot.bot_id;
  state.transcriptId = bot.transcript_id;

  console.log(`Bot created.`);
  console.log(`  bot_id        : ${bot.bot_id}`);
  console.log(`  transcript_id : ${bot.transcript_id ?? "(null - streaming-only provider?)"}`);
  console.log(`  status        : ${bot.status ?? "unknown"}`);
  console.log(`\nWaiting for the meeting to finish...\n`);
}

async function handleWebhookEvent(payload, state, onMeetingComplete) {
  // The envelope key is `event`. Anything claiming it is `bot_event` is out of date.
  const { event, bot_id: botId, bot_status: botStatus, message } = payload || {};
  if (!event) return;

  switch (event) {
    case "bot.joining":
      console.log(`[${event}] Bot is dialling into the meeting.`);
      break;
    case "bot.in_waiting_room":
      console.log(`[${event}] Bot is in the waiting room - someone needs to admit it.`);
      break;
    case "bot.inmeeting":
      console.log(`[${event}] Bot joined the meeting.`);
      break;
    case "bot.recording":
      console.log(`[${event}] Recording started.`);
      break;
    case "bot.leaving":
      console.log(`[${event}] Bot is leaving.`);
      break;
    case "bot.stopped":
      // Always status_code 200 - `bot_status` tells you why it stopped.
      console.log(`[${event}] Bot stopped. bot_status=${botStatus}${message ? ` (${message})` : ""}`);
      if (botStatus && botStatus !== "Stopped") {
        console.error(
          `  The bot did not record normally (${botStatus}). ` +
            `NotAllowed = lobby timeout, Denied = host refused, Error = internal failure.`
        );
        process.exit(1);
      }
      break;
    case "manifest.completed":
    case "audio.processed":
    case "video.processed":
      console.log(`[${event}] ...`);
      break;
    case "transcription.failed":
      console.error(`[${event}] Transcription failed: ${message ?? "no message"}`);
      process.exit(1);
      break;
    case "bot.error":
      // Non-terminal streaming-provider error. The bot keeps running.
      console.warn(`[${event}] Non-fatal error: ${message ?? "no message"}`);
      break;
    case "transcription.processed": {
      if (state.done) return;
      state.done = true;
      console.log(`[${event}] Transcript is ready.`);
      const transcriptId = state.transcriptId || (await resolveTranscriptId(botId || state.botId));
      if (!transcriptId) {
        console.error("  Could not determine transcript_id - cannot fetch the transcript.");
        process.exit(1);
      }
      await finish({ botId: botId || state.botId, transcriptId, onMeetingComplete });
      break;
    }
    default:
      console.log(`[${event}] (unhandled)`);
  }
}

/* ------------------------------------------------------------------ */
/* Shared tail: fetch transcript → hand off to the template            */
/* ------------------------------------------------------------------ */

async function finish({ botId, transcriptId, onMeetingComplete }) {
  console.log(`\nFetching transcript ${transcriptId} ...`);

  const transcript = await waitForTranscript(transcriptId, {
    attempts: Number(process.env.TRANSCRIPT_POLL_ATTEMPTS || 20),
    intervalMs: Number(process.env.TRANSCRIPT_POLL_INTERVAL_MS || 5000),
  });

  const segments = extractSegments(transcript);
  console.log(`Got ${segments.length} transcript segments.\n`);

  if (segments.length === 0) {
    console.warn("  The transcript came back empty. Nothing to send downstream.");
  }

  try {
    await onMeetingComplete({ botId, transcriptId, transcript, segments });
    console.log("\nDone.\n");
    process.exit(0);
  } catch (error) {
    console.error(`\n  Failed: ${error.message}`);
    if (error.body) console.error(JSON.stringify(error.body, null, 2));
    process.exit(1);
  }
}

function randomUuid() {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node index.js --meeting <meeting-url>     Join a live meeting (needs PUBLIC_BASE_URL)",
      "  node index.js --bot <bot_id>              Replay a finished meeting",
      "  node index.js --transcript <transcript_id> Replay a known transcript",
      "",
      "Options:",
      "  --port <n>          Webhook port (default 3000)",
      "  --public-url <url>  Public HTTPS base URL for the webhook (overrides PUBLIC_BASE_URL)",
      "",
    ].join("\n")
  );
}
