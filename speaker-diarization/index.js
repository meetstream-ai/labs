/**
 * MeetStream Labs - speaker-diarization
 *
 * Deepgram with `diarize: true`, then post-process the transcript into clean
 * per-speaker turns with talk-time statistics.
 *
 * Two ways to run it:
 *
 *   node index.js <meeting_link>        send a diarized bot, then process
 *   node index.js --bot <bot_id>        process a bot that already ran
 *   TRANSCRIPT_ID=<id> node index.js    process a transcript directly
 */

import "dotenv/config";
import path from "node:path";

import { MeetStreamError, requireApiKey } from "./src/client.js";
import { createBot, explainTerminalStatus, waitForBotToFinish } from "./src/bot.js";
import { resolveTranscriptId } from "./src/resolve.js";
import { fetchTranscript, parseSegments } from "./src/transcript.js";
import { buildTurns, enrichSpeakers, speakerStats } from "./src/diarize.js";
import { renderSpeakerTranscript, renderStatsTable, saveReport } from "./src/report.js";

const LANGUAGE = (process.env.LANGUAGE || "en").trim();
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || "nova-3";
const BOT_NAME = process.env.BOT_NAME || "MeetStream Labs Bot";
const CALLBACK_URL = (process.env.CALLBACK_URL || "").trim();
const RETENTION_HOURS = Number.parseInt(process.env.RETENTION_HOURS ?? "24", 10);
const MAX_TURN_GAP_SECONDS = Number.parseFloat(process.env.MAX_TURN_GAP_SECONDS ?? "8");
const STATUS_POLL_INTERVAL_MS = Number.parseInt(process.env.STATUS_POLL_INTERVAL_MS ?? "15000", 10);
const MAX_STATUS_POLLS = Number.parseInt(process.env.MAX_STATUS_POLLS ?? "240", 10);
const MAX_POLL_ATTEMPTS = Number.parseInt(process.env.MAX_POLL_ATTEMPTS ?? "36", 10);
const POLL_INTERVAL_MS = Number.parseInt(process.env.POLL_INTERVAL_MS ?? "5000", 10);
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR ?? "transcripts");

/** Parse `--bot <id>` out of argv, returning { botId, positional }. */
function parseArgs(argv) {
  const args = argv.slice(2);
  const flagIndex = args.indexOf("--bot");
  if (flagIndex !== -1) {
    return { botId: args[flagIndex + 1] ?? "", positional: "" };
  }
  return { botId: "", positional: args[0] ?? "" };
}

/**
 * Create a bot with diarization on.
 *
 *   recording_config.transcript.provider.deepgram.diarize = true
 */
async function createDiarizedBot(meetingLink) {
  const payload = {
    meeting_link: meetingLink,
    bot_name: BOT_NAME,
    video_required: false,
    recording_config: {
      transcript: {
        provider: {
          deepgram: {
            model: DEEPGRAM_MODEL,
            language: LANGUAGE,
            // The whole point of this template.
            diarize: true,
            smart_format: true,
            punctuate: true,
          },
        },
      },
      retention: { type: "timed", hours: RETENTION_HOURS },
    },
    custom_attributes: {
      template: "speaker-diarization",
      provider: "deepgram",
    },
  };
  if (CALLBACK_URL) payload.callback_url = CALLBACK_URL;

  console.log("POST /bots/create_bot");
  console.log(`  provider: ${JSON.stringify(payload.recording_config.transcript.provider)}`);

  const { status, data } = await createBot(payload);
  if (status === 507) {
    console.log("HTTP 507 - idempotent replay, returning the original bot. Not an error.");
  }

  const botId = data?.bot_id;
  if (!botId) throw new Error(`create_bot did not return a bot_id: ${JSON.stringify(data)}`);

  console.log(`bot_id        : ${botId}`);
  console.log(`transcript_id : ${data?.transcript_id ?? "(not returned)"}`);

  return {
    botId,
    transcriptId: typeof data?.transcript_id === "string" ? data.transcript_id : "",
  };
}

async function main() {
  requireApiKey();

  const { botId: flagBotId, positional } = parseArgs(process.argv);

  let botId = flagBotId || process.env.BOT_ID || "";
  let transcriptId = (process.env.TRANSCRIPT_ID || "").trim();
  const meetingLink = positional || process.env.MEETING_LINK || "";

  if (!transcriptId && !botId && !meetingLink) {
    console.error("Nothing to do. Provide one of:");
    console.error("  node index.js <meeting_link>      send a diarized bot");
    console.error("  node index.js --bot <bot_id>      process an existing bot");
    console.error("  TRANSCRIPT_ID=<id> node index.js  process a transcript");
    process.exit(1);
  }

  // ── Optionally send a new diarized bot ─────────────────────────────────────
  if (!transcriptId && !botId) {
    console.log(`Meeting : ${meetingLink}`);
    const created = await createDiarizedBot(meetingLink);
    botId = created.botId;
    transcriptId = created.transcriptId;

    console.log("\nWaiting for the bot to finish (polling GET /bots/{id}/status)...");
    const terminal = await waitForBotToFinish(botId, {
      maxAttempts: MAX_STATUS_POLLS,
      intervalMs: STATUS_POLL_INTERVAL_MS,
      onStatus: (value) => console.log(`  status: ${value}`),
    });

    const problem = explainTerminalStatus(terminal);
    if (problem) {
      console.error(`\n${problem}`);
      process.exit(1);
    }
  }

  // ── Resolve the transcript_id ──────────────────────────────────────────────
  if (!transcriptId) {
    const resolved = await resolveTranscriptId(botId, (msg) => console.log(msg));
    transcriptId = resolved.transcriptId;
  }

  // ── Fetch ──────────────────────────────────────────────────────────────────
  console.log(`\nGET /transcript/${transcriptId}/get_transcript?raw=false`);
  const payload = await fetchTranscript(transcriptId, {
    maxAttempts: MAX_POLL_ATTEMPTS,
    intervalMs: POLL_INTERVAL_MS,
    onWait: (attempt, max) => console.log(`  HTTP 202 - not ready yet (${attempt}/${max})...`),
  });

  // ── Post-process ───────────────────────────────────────────────────────────
  const segments = parseSegments(payload);
  if (segments.length === 0) {
    console.warn("\nNo usable segments - nothing to diarize.");
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const enriched = enrichSpeakers(segments);
  const turns = buildTurns(enriched, { maxGapSeconds: MAX_TURN_GAP_SECONDS });
  const stats = speakerStats(turns);

  const unknown = stats.find((entry) => entry.speaker === "Unknown speaker");
  if (unknown && stats.length === 1) {
    console.warn(
      "\nEvery segment came back unattributed. The bot was probably created without\n" +
        "diarize: true. Re-run it with the re-transcribe-audio template, or send a new\n" +
        "bot with this one.",
    );
  }

  console.log(`\n${segments.length} segment(s) → ${turns.length} turn(s), ${stats.length} speaker(s)\n`);
  console.log(renderStatsTable(stats));
  console.log(`\n${"-".repeat(78)}`);
  console.log(renderSpeakerTranscript(turns));
  console.log(`\n${"-".repeat(78)}`);

  const { rawPath, turnsPath, textPath } = saveReport(
    OUTPUT_DIR,
    transcriptId,
    payload,
    turns,
    stats,
  );
  console.log(`\nSaved raw JSON   → ${rawPath}`);
  console.log(`Saved turns JSON → ${turnsPath}`);
  console.log(`Saved transcript → ${textPath}`);
}

main().catch((err) => {
  if (err instanceof MeetStreamError) {
    console.error(`\nMeetStream API error: ${err.message}`);
    if (err.body) console.error(JSON.stringify(err.body, null, 2));
  } else {
    console.error(`\n${err.message}`);
  }
  process.exit(1);
});
