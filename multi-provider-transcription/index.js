/**
 * MeetStream Labs - multi-provider-transcription
 *
 * One template, five post-call transcription providers, switched with a single
 * environment variable. Sends a bot to a meeting, waits for it to finish, then
 * fetches and prints the transcript.
 *
 *   PROVIDER=deepgram    node index.js <meeting_link>
 *   PROVIDER=assemblyai  node index.js <meeting_link>
 *   PROVIDER=sarvam      node index.js <meeting_link>
 *   PROVIDER=jigsawstack node index.js <meeting_link>
 *   PROVIDER=meetstream  node index.js <meeting_link>
 */

import "dotenv/config";
import path from "node:path";

import { MeetStreamError, requireApiKey } from "./src/client.js";
import { PROVIDER_KEYS, PROVIDERS, buildProviderBlock } from "./src/providers.js";
import { createBot, explainTerminalStatus, waitForBotToFinish } from "./src/bot.js";
import { resolveTranscriptId } from "./src/resolve.js";
import { fetchTranscript, parseSegments, toSpeakerTurns } from "./src/transcript.js";
import { renderTranscript, saveTranscript } from "./src/format.js";

const PROVIDER = (process.env.PROVIDER || "deepgram").trim();
const LANGUAGE = (process.env.LANGUAGE || "").trim();
const DIARIZE = process.env.DIARIZE === "true";
const BOT_NAME = process.env.BOT_NAME || "MeetStream Labs Bot";
const CALLBACK_URL = (process.env.CALLBACK_URL || "").trim();
const RETENTION_HOURS = Number.parseInt(process.env.RETENTION_HOURS ?? "24", 10);
const STATUS_POLL_INTERVAL_MS = Number.parseInt(process.env.STATUS_POLL_INTERVAL_MS ?? "15000", 10);
const MAX_STATUS_POLLS = Number.parseInt(process.env.MAX_STATUS_POLLS ?? "240", 10);
const MAX_POLL_ATTEMPTS = Number.parseInt(process.env.MAX_POLL_ATTEMPTS ?? "36", 10);
const POLL_INTERVAL_MS = Number.parseInt(process.env.POLL_INTERVAL_MS ?? "5000", 10);
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR ?? "transcripts");

async function main() {
  requireApiKey();

  const meetingLink = process.argv[2] || process.env.MEETING_LINK || "";
  if (!meetingLink) {
    console.error("Provide a meeting link: `node index.js <meeting_link>` or set MEETING_LINK.");
    console.error(`Providers: ${PROVIDER_KEYS.join(" | ")}`);
    process.exit(1);
  }

  const providerBlock = buildProviderBlock(PROVIDER, {
    language: LANGUAGE || undefined,
    diarize: DIARIZE,
  });
  const meta = PROVIDERS[PROVIDER];

  if (DIARIZE && !meta.diarizationField) {
    console.warn(`Note: ${meta.label} has no diarization option - DIARIZE is ignored.\n`);
  }

  console.log(`Provider : ${meta.label} (${PROVIDER})`);
  console.log(`Config   : ${JSON.stringify(providerBlock[PROVIDER])}`);
  console.log(`Meeting  : ${meetingLink}`);

  // ── Create the bot ─────────────────────────────────────────────────────────
  const payload = {
    meeting_link: meetingLink,
    bot_name: BOT_NAME,
    video_required: false,
    recording_config: {
      transcript: { provider: providerBlock },
      retention: { type: "timed", hours: RETENTION_HOURS },
    },
    custom_attributes: {
      // Values must be strings. Echoed back in every webhook.
      template: "multi-provider-transcription",
      provider: PROVIDER,
    },
  };
  if (CALLBACK_URL) payload.callback_url = CALLBACK_URL;

  console.log("\nPOST /bots/create_bot");
  const { status, data } = await createBot(payload);
  if (status === 507) {
    console.log("HTTP 507 - idempotent replay, returning the original bot. Not an error.");
  }

  const botId = data?.bot_id;
  if (!botId) {
    throw new Error(`create_bot did not return a bot_id: ${JSON.stringify(data)}`);
  }

  // The create response is the cheapest source of transcript_id. Keep it.
  let transcriptId = typeof data?.transcript_id === "string" ? data.transcript_id : "";

  console.log(`bot_id        : ${botId}`);
  console.log(`transcript_id : ${transcriptId || "(not returned - will resolve later)"}`);
  console.log(`status        : ${data?.status ?? "?"}`);

  // ── Wait for the meeting to finish ─────────────────────────────────────────
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

  // ── Resolve the transcript_id if create_bot did not give us one ────────────
  if (!transcriptId) {
    const resolved = await resolveTranscriptId(botId, (msg) => console.log(msg));
    transcriptId = resolved.transcriptId;
  }

  // ── Fetch, polling on 202 ──────────────────────────────────────────────────
  console.log(`\nGET /transcript/${transcriptId}/get_transcript?raw=false`);
  const transcriptPayload = await fetchTranscript(transcriptId, {
    maxAttempts: MAX_POLL_ATTEMPTS,
    intervalMs: POLL_INTERVAL_MS,
    onWait: (attempt, max) =>
      console.log(`  HTTP 202 - transcription still running (${attempt}/${max})...`),
  });

  const segments = parseSegments(transcriptPayload);
  if (segments.length === 0) {
    console.warn("\nNo usable segments. Nobody spoke, or no speech was recognised.");
    console.log(JSON.stringify(transcriptPayload, null, 2));
    return;
  }

  const turns = toSpeakerTurns(segments);
  const speakers = new Set(turns.map((turn) => turn.speaker));
  console.log(
    `\n${meta.label}: ${segments.length} segment(s) → ${turns.length} turn(s), ` +
      `${speakers.size} speaker(s)\n`,
  );
  console.log("-".repeat(78));
  console.log(renderTranscript(turns));
  console.log(`\n${"-".repeat(78)}`);

  const fileStem = `${PROVIDER}-${transcriptId}`;
  const { jsonPath, textPath } = saveTranscript(OUTPUT_DIR, fileStem, transcriptPayload, turns);
  console.log(`\nSaved JSON → ${jsonPath}`);
  console.log(`Saved text → ${textPath}`);
  console.log("\nRun again with a different PROVIDER to compare on the same meeting.");
}

main().catch((err) => {
  if (err instanceof MeetStreamError) {
    console.error(`\nMeetStream API error: ${err.message}`);
    if (err.status === 400) {
      console.error(
        "A 400 on create_bot is usually the provider config: check you set exactly one\n" +
          "provider key, and that AssemblyAI got speech_models / language_code rather\n" +
          "than Deepgram's model / language.",
      );
    }
    if (err.body) console.error(JSON.stringify(err.body, null, 2));
  } else {
    console.error(`\n${err.message}`);
  }
  process.exit(1);
});
