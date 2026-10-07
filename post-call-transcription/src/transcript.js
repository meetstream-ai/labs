const fs = require("fs");
const path = require("path");
const { request } = require("./client");

// Cap on how many times we poll a not-yet-ready transcript (HTTP 202).
// At 5s per attempt, 12 attempts = 60s of waiting before giving up.
const MAX_RETRIES = parseInt(process.env.TRANSCRIPT_POLL_ATTEMPTS || "12", 10);
const RETRY_DELAY_MS = parseInt(process.env.TRANSCRIPT_POLL_INTERVAL_MS || "5000", 10);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetches the post-call transcript for a transcript_id, polling while the API
 * answers HTTP 202, then prints and saves it.
 *
 * @param {string} transcriptId  From the create_bot response (never from a webhook)
 * @returns {Promise<boolean>}   true when a transcript was saved
 */
async function fetchTranscript(transcriptId) {
  if (!transcriptId) {
    console.warn("   No transcript_id available - skipping fetch.");
    return false;
  }

  console.log(`\n  Fetching transcript (id: ${transcriptId})...`);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let result;
    try {
      result = await request(`/transcript/${encodeURIComponent(transcriptId)}/get_transcript`);
    } catch (err) {
      console.error(`  Failed to fetch transcript: ${err.message}`);
      if (err.body && typeof err.body === "object") console.error(JSON.stringify(err.body, null, 2));
      return false;
    }

    // 202 = still processing. Anything else that got here is the transcript.
    if (result.status !== 202) {
      printTranscript(result.data);
      saveTranscript(transcriptId, result.data);
      return true;
    }

    if (attempt === MAX_RETRIES) break;
    console.log(
      `  Transcript not ready yet (HTTP 202) - retrying in ${Math.round(RETRY_DELAY_MS / 1000)}s... (attempt ${attempt}/${MAX_RETRIES})`
    );
    await sleep(RETRY_DELAY_MS);
  }

  console.error(`  Transcript still returned HTTP 202 after ${MAX_RETRIES} attempts - giving up.`);
  console.error("   Try again later with this transcript_id (raise TRANSCRIPT_POLL_ATTEMPTS for long meetings):");
  console.error(`   ${transcriptId}`);
  return false;
}

/** Depth-first search for a non-empty `transcript_id` string in a payload. */
function findTranscriptId(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 5) return null;
  if (!Array.isArray(node) && typeof node.transcript_id === "string" && node.transcript_id) {
    return node.transcript_id;
  }
  for (const value of Object.values(node)) {
    const hit = findTranscriptId(value, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * transcript_id is never in a webhook. When create_bot did not return one,
 * look it up on GET /bots/{id}/detail, then GET /bots/{id}/transcriptions.
 * @param {string} botId
 * @returns {Promise<string|null>}
 */
async function resolveTranscriptId(botId) {
  if (!botId) return null;
  for (const suffix of ["detail", "transcriptions"]) {
    try {
      const { data } = await request(`/bots/${encodeURIComponent(botId)}/${suffix}`);
      const id = findTranscriptId(data);
      if (id) return id;
    } catch (err) {
      console.warn(`   GET /bots/${botId}/${suffix} failed: ${err.message}`);
    }
  }
  return null;
}

/**
 * Normalises a MeetStream transcript payload into a flat array of:
 *   { speaker: string, transcript: string, start_time: number|null }
 *
 * The processed response (raw=false) is an ARRAY of segments whose text lives
 * in `transcript`, not `text`:
 *   [ { speaker, transcript, start_time, end_time, words: [...] } ]
 *
 * Also tolerated: the same array wrapped under `transcript` / `data`, and the
 * provider-raw shape `{ message: [ { participant: { name }, words: [ { text,
 * start_timestamp: { relative } } ] } ] }`.
 */
function parseSegments(data) {
  // Provider-raw shape.
  if (Array.isArray(data?.message)) {
    const segments = [];
    for (const entry of data.message) {
      const speaker = entry?.participant?.name ?? entry?.speaker ?? "Unknown Speaker";
      const words = entry?.words ?? [];
      if (words.length === 0) continue;
      const transcript = words.map((w) => w.punctuated_word ?? w.word ?? w.text ?? "").join(" ").trim();
      const start_time = words[0]?.start_timestamp?.relative ?? words[0]?.start ?? null;
      if (transcript) segments.push({ speaker, transcript, start_time });
    }
    return segments;
  }

  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.transcript)
      ? data.transcript
      : Array.isArray(data?.data)
        ? data.data
        : [];

  return list
    .map((segment) => ({
      speaker: segment?.speaker ?? segment?.participant?.name ?? "Unknown Speaker",
      // `transcript` is the real field. `text` is only a tolerant fallback.
      transcript: String(segment?.transcript ?? segment?.text ?? "").trim(),
      start_time: typeof segment?.start_time === "number" ? segment.start_time : null,
    }))
    .filter((segment) => segment.transcript.length > 0);
}

/**
 * Pretty-prints the transcript to stdout.
 */
function printTranscript(data) {
  const segments = parseSegments(data);

  console.log("\n" + "-".repeat(60));
  console.log("    TRANSCRIPT");
  console.log("-".repeat(60));

  if (segments.length > 0) {
    segments.forEach(({ speaker, transcript, start_time }) => {
      const timestamp = start_time != null ? `[${formatTime(start_time)}] ` : "";
      console.log(`\n${timestamp}${speaker}`);
      console.log(`  ${transcript}`);
    });
  } else if (typeof data === "string") {
    console.log(data);
  } else {
    console.log("(No transcript segments found - nobody spoke, or no speech was recognised.)");
    console.log(JSON.stringify(data, null, 2));
  }

  console.log("\n" + "-".repeat(60) + "\n");
}

/**
 * Saves two files into ./transcripts/:
 *   <id>.json  - raw JSON for developers / integrations
 *   <id>.txt   - clean human-readable transcript for non-technical readers
 */
function saveTranscript(transcriptId, data) {
  const dir = path.join(process.cwd(), process.env.OUTPUT_DIR || "transcripts");
  fs.mkdirSync(dir, { recursive: true });

  // 1) Raw JSON (for devs)
  const jsonFile = path.join(dir, `${transcriptId}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify(data, null, 2), "utf8");
  console.log(`  Raw JSON  saved -> ${jsonFile}`);

  // 2) Human-readable TXT (for everyone else)
  const txtFile = path.join(dir, `${transcriptId}.txt`);
  fs.writeFileSync(txtFile, buildReadableTxt(data), "utf8");
  console.log(`  Readable TXT saved -> ${txtFile}`);

  console.log("\n  All done. Shutting down.\n");
}

/**
 * Converts the transcript JSON into a clean, human-readable text document.
 *
 * Output looks like:
 *
 *   MEETING TRANSCRIPT
 *   Generated: 10 June 2026, 14:32
 *   ------------------------------------------------------------
 *
 *   [00:11]  dharrun 17
 *            Hi guys, hope you are all doing well.
 *
 *   [00:18]  Alice
 *            Thanks for joining everyone.
 */
function buildReadableTxt(data) {
  const segments = parseSegments(data);
  const generatedAt = new Date().toLocaleString("en-GB", {
    day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  const lines = [];
  lines.push("MEETING TRANSCRIPT");
  lines.push(`Generated: ${generatedAt}`);
  lines.push("-".repeat(60));

  if (segments.length > 0) {
    // Group consecutive turns from the same speaker
    const grouped = [];
    for (const seg of segments) {
      const prev = grouped[grouped.length - 1];
      if (prev && prev.speaker === seg.speaker) {
        prev.transcript += " " + seg.transcript;
      } else {
        grouped.push({ ...seg });
      }
    }

    for (const { speaker, transcript, start_time } of grouped) {
      const ts = start_time != null ? `[${formatTime(start_time)}]` : "       ";
      lines.push("");
      lines.push(`${ts}  ${speaker}`);
      lines.push(...wrapText(transcript, 72, "         "));
    }
  } else if (typeof data === "string") {
    lines.push("", data);
  } else {
    lines.push("", "(No transcript segments found)");
  }

  lines.push("");
  lines.push("-".repeat(60));
  lines.push("End of transcript");

  return lines.join("\n");
}

/**
 * Word-wraps a string at `maxWidth` characters.
 * Subsequent lines are indented by `indent`.
 */
function wrapText(text, maxWidth, indent) {
  const words = text.split(" ");
  const result = [];
  let current = indent;

  for (const word of words) {
    if (current.length + word.length + 1 > maxWidth && current.trim() !== "") {
      result.push(current);
      current = indent + word;
    } else {
      current += (current.trim() === "" ? "" : " ") + word;
    }
  }
  if (current.trim()) result.push(current);
  return result;
}

/** Converts seconds to mm:ss */
function formatTime(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

module.exports = { fetchTranscript, resolveTranscriptId, parseSegments };
