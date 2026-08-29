/**
 * MeetStream Labs - re-transcribe-audio
 *
 * Re-run transcription on a bot that has already finished, with a different
 * provider, model, or language.
 *
 *   POST /bots/{bot_id}/transcribe
 *     { "provider": { "<key>": { ... } }, "callback_url": "https://..." }
 *
 * The recorded audio stays put; each run produces a new transcript_id and the
 * earlier transcripts remain available.
 *
 * Usage:
 *   node index.js <bot_id>
 *   PROVIDER=sarvam LANGUAGE=hi-IN node index.js <bot_id>
 */

import "dotenv/config";
import path from "node:path";

import { MeetStreamError, requireApiKey } from "./src/client.js";
import { listTranscriptions } from "./src/resolve.js";
import { assertPostCallProvider, buildProviderBlock } from "./src/providers.js";
import {
  findNewTranscriptId,
  snapshotTranscriptIds,
  startReTranscription,
} from "./src/retranscribe.js";
import { fetchTranscript, parseSegments, toSpeakerTurns } from "./src/transcript.js";
import { renderTranscript, saveTranscript } from "./src/format.js";

const PROVIDER = (process.env.PROVIDER || "deepgram").trim();
const LANGUAGE = (process.env.LANGUAGE || "").trim();
const DIARIZE = process.env.DIARIZE === "true";
const CALLBACK_URL = (process.env.CALLBACK_URL || "").trim();
const WAIT_FOR_TRANSCRIPT = process.env.WAIT_FOR_TRANSCRIPT !== "false";
const MAX_POLL_ATTEMPTS = Number.parseInt(process.env.MAX_POLL_ATTEMPTS ?? "36", 10);
const POLL_INTERVAL_MS = Number.parseInt(process.env.POLL_INTERVAL_MS ?? "5000", 10);
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR ?? "transcripts");

async function main() {
  requireApiKey();

  const botId = process.argv[2] || process.env.BOT_ID || "";
  if (!botId) {
    console.error("Provide a bot_id: `node index.js <bot_id>` or set BOT_ID in .env");
    process.exit(1);
  }

  assertPostCallProvider(PROVIDER);
  const providerBlock = buildProviderBlock(PROVIDER, {
    language: LANGUAGE || undefined,
    diarize: DIARIZE,
  });

  console.log(`Bot      : ${botId}`);
  console.log(`Provider : ${PROVIDER}`);
  console.log(`Config   : ${JSON.stringify(providerBlock[PROVIDER])}`);
  if (CALLBACK_URL) console.log(`Callback : ${CALLBACK_URL}`);

  // ── Show what already exists, so the new run is easy to spot ───────────────
  const existing = await listTranscriptions(botId).catch(() => []);
  if (existing.length > 0) {
    console.log(`\nExisting transcription runs (${existing.length}):`);
    for (const run of existing) {
      console.log(
        `  ${run.transcript_id}  provider=${run.provider ?? "?"}  status=${run.status ?? "?"}  created=${run.created_at ?? "?"}`,
      );
    }
  } else {
    console.log("\nNo transcription runs exist for this bot yet.");
  }

  const before = new Set(existing.map((run) => run.transcript_id));

  // ── Trigger the re-transcription ───────────────────────────────────────────
  console.log(`\nPOST /bots/${botId}/transcribe`);
  const response = await startReTranscription(botId, providerBlock, CALLBACK_URL || undefined);
  console.log("Accepted.");
  if (response) console.log(JSON.stringify(response, null, 2));

  // ── Identify the new run ───────────────────────────────────────────────────
  const { transcriptId, run } = await findNewTranscriptId(botId, before, response, {
    onWait: (attempt, max) =>
      console.log(`  Waiting for the new transcript_id to appear (${attempt}/${max})...`),
  });
  console.log(`\nNew transcript_id: ${transcriptId}`);
  if (run) console.log(`  provider=${run.provider ?? "?"}  status=${run.status ?? "?"}`);

  if (!WAIT_FOR_TRANSCRIPT) {
    console.log("\nWAIT_FOR_TRANSCRIPT=false - not polling.");
    if (CALLBACK_URL) {
      console.log("You will receive transcription.processed (or transcription.failed) at your callback_url.");
    }
    console.log(`Fetch it later with: TRANSCRIPT_ID=${transcriptId} node index.js`);
    return;
  }

  // ── Poll until the transcript is ready ─────────────────────────────────────
  console.log(`\nGET /transcript/${transcriptId}/get_transcript?raw=false`);
  const payload = await fetchTranscript(transcriptId, {
    maxAttempts: MAX_POLL_ATTEMPTS,
    intervalMs: POLL_INTERVAL_MS,
    onWait: (attempt, max) =>
      console.log(`  HTTP 202 - transcription still running (${attempt}/${max})...`),
  });

  const segments = parseSegments(payload);
  if (segments.length === 0) {
    console.warn("\nThe re-transcription returned no usable segments.");
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const turns = toSpeakerTurns(segments);
  console.log(`\n${segments.length} segment(s) → ${turns.length} speaker turn(s)\n`);
  console.log("-".repeat(78));
  console.log(renderTranscript(turns));
  console.log(`\n${"-".repeat(78)}`);

  const { jsonPath, textPath } = saveTranscript(OUTPUT_DIR, transcriptId, payload, turns);
  console.log(`\nSaved JSON → ${jsonPath}`);
  console.log(`Saved text → ${textPath}`);
}

main().catch((err) => {
  if (err instanceof MeetStreamError) {
    console.error(`\nMeetStream API error: ${err.message}`);
    if (err.status === 404) {
      console.error("Check the bot_id. The bot must exist and have a stored recording.");
    }
    if (err.body) console.error(JSON.stringify(err.body, null, 2));
  } else {
    console.error(`\n${err.message}`);
  }
  process.exit(1);
});
