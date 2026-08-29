/**
 * MeetStream Labs - multilingual-transcription
 *
 * Transcribe meetings that are not in English, with the right provider and the
 * right language code for that provider.
 *
 *   PROVIDER=sarvam     LANGUAGE=ta-IN node index.js <meeting_link>   # Tamil
 *   PROVIDER=deepgram   LANGUAGE=es    node index.js <meeting_link>   # Spanish
 *   PROVIDER=assemblyai LANGUAGE=de    node index.js <meeting_link>   # German
 *   PROVIDER=jigsawstack TRANSLATE=true node index.js <meeting_link>  # detect + translate
 *
 * List the codes each provider expects:
 *   node index.js --languages
 */

import "dotenv/config";
import path from "node:path";

import { MeetStreamError, requireApiKey } from "./src/client.js";
import { checkLanguageFormat, describeLanguages } from "./src/languages.js";
import {
  AUTO_DETECT_PROVIDERS,
  PROVIDER_KEYS,
  TRANSLATING_PROVIDERS,
  buildProviderBlock,
  languageFieldFor,
} from "./src/providers.js";
import { createBot, explainTerminalStatus, waitForBotToFinish } from "./src/bot.js";
import { resolveTranscriptId } from "./src/resolve.js";
import { fetchTranscript, parseSegments, toSpeakerTurns } from "./src/transcript.js";
import { renderTranscript, saveTranscript } from "./src/format.js";

const PROVIDER = (process.env.PROVIDER || "deepgram").trim();
const LANGUAGE = (process.env.LANGUAGE || "").trim();
const TRANSLATE = process.env.TRANSLATE === "true";
const DIARIZE = process.env.DIARIZE === "true";
const BOT_NAME = process.env.BOT_NAME || "MeetStream Labs Bot";
const CALLBACK_URL = (process.env.CALLBACK_URL || "").trim();
const RETENTION_HOURS = Number.parseInt(process.env.RETENTION_HOURS ?? "24", 10);
const STATUS_POLL_INTERVAL_MS = Number.parseInt(process.env.STATUS_POLL_INTERVAL_MS ?? "15000", 10);
const MAX_STATUS_POLLS = Number.parseInt(process.env.MAX_STATUS_POLLS ?? "240", 10);
const MAX_POLL_ATTEMPTS = Number.parseInt(process.env.MAX_POLL_ATTEMPTS ?? "36", 10);
const POLL_INTERVAL_MS = Number.parseInt(process.env.POLL_INTERVAL_MS ?? "5000", 10);
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR ?? "transcripts");

function printLanguageCatalogue() {
  console.log("Language codes by provider\n");
  for (const provider of PROVIDER_KEYS) {
    console.log(describeLanguages(provider));
    console.log("");
  }
  console.log("These are common examples, not the providers' full supported lists.");
}

async function main() {
  if (process.argv.includes("--languages")) {
    printLanguageCatalogue();
    return;
  }

  requireApiKey();

  const meetingLink = process.argv[2] || process.env.MEETING_LINK || "";
  if (!meetingLink) {
    console.error("Provide a meeting link: `node index.js <meeting_link>` or set MEETING_LINK.");
    console.error("Run `node index.js --languages` to see the codes each provider expects.");
    process.exit(1);
  }

  // ── Warn about format mix-ups before the API rejects them ──────────────────
  const warnings = checkLanguageFormat(PROVIDER, LANGUAGE);
  for (const warning of warnings) console.warn(`Warning: ${warning}`);
  if (warnings.length > 0) console.warn("");

  if (TRANSLATE && !TRANSLATING_PROVIDERS.has(PROVIDER)) {
    console.warn(
      `Warning: ${PROVIDER} has no translate option - TRANSLATE is ignored. ` +
        `Use jigsawstack or meetstream to translate.\n`,
    );
  }
  if (!LANGUAGE && !AUTO_DETECT_PROVIDERS.has(PROVIDER)) {
    console.warn(
      `Warning: no LANGUAGE set. ${PROVIDER} will use its default (usually English), ` +
        "which will mis-transcribe a non-English call rather than fail.\n",
    );
  }

  const providerBlock = buildProviderBlock(PROVIDER, {
    language: LANGUAGE || undefined,
    diarize: DIARIZE,
    translate: TRANSLATE,
  });

  console.log(`Provider       : ${PROVIDER}`);
  console.log(`Language field : ${languageFieldFor(PROVIDER)}`);
  console.log(`Language value : ${LANGUAGE || "(provider default)"}`);
  console.log(`Config         : ${JSON.stringify(providerBlock[PROVIDER])}`);
  console.log(`Meeting        : ${meetingLink}`);

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
      // custom_attributes values must be strings.
      template: "multilingual-transcription",
      provider: PROVIDER,
      language: LANGUAGE || "default",
    },
  };
  if (CALLBACK_URL) payload.callback_url = CALLBACK_URL;

  console.log("\nPOST /bots/create_bot");
  const { status, data } = await createBot(payload);
  if (status === 507) {
    console.log("HTTP 507 - idempotent replay, returning the original bot. Not an error.");
  }

  const botId = data?.bot_id;
  if (!botId) throw new Error(`create_bot did not return a bot_id: ${JSON.stringify(data)}`);

  let transcriptId = typeof data?.transcript_id === "string" ? data.transcript_id : "";
  console.log(`bot_id        : ${botId}`);
  console.log(`transcript_id : ${transcriptId || "(not returned - will resolve later)"}`);

  // ── Wait for the meeting to end ────────────────────────────────────────────
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

  if (!transcriptId) {
    const resolved = await resolveTranscriptId(botId, (msg) => console.log(msg));
    transcriptId = resolved.transcriptId;
  }

  // ── Fetch ──────────────────────────────────────────────────────────────────
  console.log(`\nGET /transcript/${transcriptId}/get_transcript?raw=false`);
  const transcriptPayload = await fetchTranscript(transcriptId, {
    maxAttempts: MAX_POLL_ATTEMPTS,
    intervalMs: POLL_INTERVAL_MS,
    onWait: (attempt, max) => console.log(`  HTTP 202 - not ready yet (${attempt}/${max})...`),
  });

  const segments = parseSegments(transcriptPayload);
  if (segments.length === 0) {
    console.warn("\nNo usable segments came back.");
    console.warn(
      "For a non-English call this usually means the language code was wrong or was\n" +
        "sent in the wrong field, so the provider tried the wrong language.",
    );
    console.log(JSON.stringify(transcriptPayload, null, 2));
    return;
  }

  const turns = toSpeakerTurns(segments);
  console.log(`\n${segments.length} segment(s) → ${turns.length} turn(s)\n`);
  console.log("-".repeat(78));
  // Non-Latin scripts print correctly: Node writes UTF-8 to stdout by default.
  console.log(renderTranscript(turns));
  console.log(`\n${"-".repeat(78)}`);

  const fileStem = `${PROVIDER}-${LANGUAGE || "auto"}-${transcriptId}`;
  const { jsonPath, textPath } = saveTranscript(OUTPUT_DIR, fileStem, transcriptPayload, turns);
  console.log(`\nSaved JSON → ${jsonPath}`);
  console.log(`Saved text → ${textPath}`);
}

main().catch((err) => {
  if (err instanceof MeetStreamError) {
    console.error(`\nMeetStream API error: ${err.message}`);
    if (err.status === 400) {
      console.error(
        "A 400 here is nearly always the language code: wrong format for the provider,\n" +
          "or sent in the wrong field. Run `node index.js --languages`.",
      );
    }
    if (err.body) console.error(JSON.stringify(err.body, null, 2));
  } else {
    console.error(`\n${err.message}`);
  }
  process.exit(1);
});
