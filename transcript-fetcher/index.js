/**
 * MeetStream Labs - transcript-fetcher
 *
 * The canonical way to retrieve a finished MeetStream transcript:
 *
 *   bot_id ──► GET /bots/{id}/detail          ─┐
 *          └─► GET /bots/{id}/transcriptions  ─┴──► transcript_id
 *                                                        │
 *                            GET /transcript/{transcript_id}/get_transcript
 *                                                        │
 *                                    202? poll (capped)  │
 *                                                        ▼
 *                                     segments: { speaker, transcript }
 *
 * Usage:
 *   node index.js <bot_id>
 *   BOT_ID=<bot_id> node index.js
 *   TRANSCRIPT_ID=<transcript_id> node index.js     # skip resolution entirely
 */

import "dotenv/config";
import path from "node:path";

import { MeetStreamError, requireApiKey } from "./src/client.js";
import { resolveTranscriptId } from "./src/resolve.js";
import { fetchTranscript, parseSegments, toSpeakerTurns } from "./src/transcript.js";
import { renderTranscript, saveTranscript } from "./src/format.js";

const RAW = process.env.RAW === "true";
const MAX_POLL_ATTEMPTS = Number.parseInt(process.env.MAX_POLL_ATTEMPTS ?? "24", 10);
const POLL_INTERVAL_MS = Number.parseInt(process.env.POLL_INTERVAL_MS ?? "5000", 10);
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR ?? "transcripts");

function usage(message) {
  if (message) console.error(`${message}\n`);
  console.error("Usage:");
  console.error("  node index.js <bot_id>");
  console.error("  BOT_ID=<bot_id> node index.js");
  console.error("  TRANSCRIPT_ID=<transcript_id> node index.js");
  process.exit(1);
}

async function main() {
  requireApiKey();

  const botId = process.argv[2] || process.env.BOT_ID || "";
  const directTranscriptId = process.env.TRANSCRIPT_ID || "";

  if (!botId && !directTranscriptId) {
    usage("Provide a bot_id (argument or BOT_ID), or a TRANSCRIPT_ID.");
  }

  // ── Step 1: get a transcript_id ────────────────────────────────────────────
  let transcriptId = directTranscriptId;
  if (transcriptId) {
    console.log(`Using transcript_id from the environment: ${transcriptId}`);
  } else {
    const resolved = await resolveTranscriptId(botId, (msg) => console.log(msg));
    transcriptId = resolved.transcriptId;
    console.log(`Resolved transcript_id ${transcriptId} from ${resolved.source}`);

    if (resolved.run && String(resolved.run.status).toLowerCase() === "failed") {
      console.warn(
        "\nWarning: the newest transcription run has status 'Failed'. " +
          "Re-run it with the re-transcribe-audio template before fetching.\n",
      );
    }
  }

  // ── Step 2: fetch, polling on 202 ──────────────────────────────────────────
  console.log(`\nGET /transcript/${transcriptId}/get_transcript?raw=${RAW}`);
  const payload = await fetchTranscript(transcriptId, {
    raw: RAW,
    maxAttempts: MAX_POLL_ATTEMPTS,
    intervalMs: POLL_INTERVAL_MS,
    onWait: (attempt, max) =>
      console.log(`  HTTP 202 - not ready yet (attempt ${attempt}/${max}), retrying...`),
  });

  if (RAW) {
    // raw=true returns whatever the provider produced; there is no guaranteed
    // segment shape, so print it as-is rather than pretending to parse it.
    console.log("\nRaw provider output:\n");
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  // ── Step 3: parse using speaker + transcript ───────────────────────────────
  const segments = parseSegments(payload);

  if (segments.length === 0) {
    console.warn("\nThe transcript came back empty (0 usable segments).");
    console.warn("Nobody spoke, or the audio contained no recognisable speech.");
    console.log("\nRaw payload:");
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const turns = toSpeakerTurns(segments);
  const speakers = new Set(turns.map((turn) => turn.speaker));

  console.log(
    `\n${segments.length} segment(s) → ${turns.length} speaker turn(s) ` +
      `across ${speakers.size} speaker(s)\n`,
  );
  console.log("-".repeat(78));
  console.log(renderTranscript(turns));
  console.log(`\n${"-".repeat(78)}`);

  // ── Step 4: persist ────────────────────────────────────────────────────────
  const { jsonPath, textPath } = saveTranscript(OUTPUT_DIR, transcriptId, payload, turns);
  console.log(`\nSaved JSON → ${jsonPath}`);
  console.log(`Saved text → ${textPath}`);
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
