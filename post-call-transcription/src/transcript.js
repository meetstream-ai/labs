const axios = require("axios");
const fs = require("fs");
const path = require("path");

const API_BASE = "https://api.meetstream.ai/api/v1";

// Cap on how many times we'll retry fetching a not-yet-ready transcript.
// At 5s per retry, 12 retries = 60s of waiting before giving up.
const MAX_RETRIES = 12;

/**
 * Fetches the formatted post-call transcript for a given transcript_id.
 * @param {string} transcriptId  The transcript_id returned when the bot was created
 * @param {number} attempt       Internal retry counter — do not set manually
 */
async function fetchTranscript(transcriptId, attempt = 1) {
  if (!transcriptId) {
    console.warn("   No transcript_id available — skipping fetch.");
    return;
  }

  console.log(`\n  Fetching transcript (id: ${transcriptId})...`);

  try {
    const { data } = await axios.get(
      `${API_BASE}/transcript/${transcriptId}/get_transcript`,
      {
        headers: {
          Authorization: `Token ${process.env.MEETSTREAM_API_KEY}`,
        },
      }
    );

    printTranscript(data);
    saveTranscript(transcriptId, data);
  } catch (err) {
    // Transcript may still be processing — retry with a capped attempt count
    if (err.response?.status === 404 || err.response?.status === 202) {
      if (attempt >= MAX_RETRIES) {
        console.error(
          `  Transcript still not ready after ${MAX_RETRIES} attempts — giving up.`
        );
        console.error("   Try fetching it manually later with this transcript_id:");
        console.error(`   ${transcriptId}`);
        return;
      }
      console.log(
        `  Transcript not ready yet — retrying in 5 seconds... (attempt ${attempt}/${MAX_RETRIES})`
      );
      setTimeout(() => fetchTranscript(transcriptId, attempt + 1), 5000);
    } else {
      console.error(
        `  Failed to fetch transcript (HTTP ${err.response?.status}):`
      );
      console.error(JSON.stringify(err.response?.data ?? err.message, null, 2));
    }
  }
}

/**
 * Normalises any MeetStream transcript shape into a flat array of:
 *   { speaker: string, text: string, start_time: number }
 *
 * Handles two known shapes:
 *
 *  Shape A — actual API response:
 *    { message: [ { participant: { name }, words: [ { text, start_timestamp: { relative } } ] } ] }
 *
 *  Shape B — docs / older format:
 *    { transcript: [ { speaker, text, start_time } ] }
 */
function parseSegments(data) {
  // Shape A
  if (Array.isArray(data?.message)) {
    const segments = [];
    for (const entry of data.message) {
      const speaker = entry?.participant?.name ?? "Unknown Speaker";
      const words = entry?.words ?? [];
      if (words.length === 0) continue;

      const text = words.map((w) => w.text).join(" ").trim();
      const start_time = words[0]?.start_timestamp?.relative ?? null;
      segments.push({ speaker, text, start_time });
    }
    return segments;
  }

  // Shape B
  if (Array.isArray(data?.transcript)) return data.transcript;
  if (Array.isArray(data?.data))       return data.data;
  if (Array.isArray(data))             return data;

  return [];
}

/**
 * Pretty-prints the transcript to stdout.
 */
function printTranscript(data) {
  const segments = parseSegments(data);

  console.log("\n" + "─".repeat(60));
  console.log("    TRANSCRIPT");
  console.log("─".repeat(60));

  if (segments.length > 0) {
    segments.forEach(({ speaker, text, start_time }) => {
      const timestamp = start_time != null ? `[${formatTime(start_time)}] ` : "";
      console.log(`\n${timestamp}${speaker}`);
      console.log(`  ${text}`);
    });
  } else if (typeof data === "string") {
    console.log(data);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }

  console.log("\n" + "─".repeat(60) + "\n");
}

/**
 * Saves two files into ./transcripts/:
 *   <id>.json  — raw JSON for developers / integrations
 *   <id>.txt   — clean human-readable transcript for non-technical readers
 */
function saveTranscript(transcriptId, data) {
  const dir = path.join(process.cwd(), "transcripts");
  fs.mkdirSync(dir, { recursive: true });

  // 1) Raw JSON (for devs)
  const jsonFile = path.join(dir, `${transcriptId}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify(data, null, 2), "utf8");
  console.log(`  Raw JSON  saved → ${jsonFile}`);

  // 2) Human-readable TXT (for everyone else)
  const txtFile = path.join(dir, `${transcriptId}.txt`);
  fs.writeFileSync(txtFile, buildReadableTxt(data), "utf8");
  console.log(`  Readable TXT saved → ${txtFile}`);

  console.log("\n  All done. Shutting down.\n");
  process.exit(0);
}

/**
 * Converts the transcript JSON into a clean, human-readable text document.
 *
 * Output looks like:
 *
 *   MEETING TRANSCRIPT
 *   Generated: 10 June 2026, 14:32
 *   ────────────────────────────────────────────────────────────
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
  lines.push("─".repeat(60));

  if (segments.length > 0) {
    // Group consecutive turns from the same speaker
    const grouped = [];
    for (const seg of segments) {
      const prev = grouped[grouped.length - 1];
      if (prev && prev.speaker === seg.speaker) {
        prev.text += " " + seg.text;
      } else {
        grouped.push({ ...seg });
      }
    }

    for (const { speaker, text, start_time } of grouped) {
      const ts = start_time != null ? `[${formatTime(start_time)}]` : "       ";
      lines.push("");
      lines.push(`${ts}  ${speaker}`);
      lines.push(...wrapText(text, 72, "         "));
    }
  } else if (typeof data === "string") {
    lines.push("", data);
  } else {
    lines.push("", "(No transcript segments found)");
  }

  lines.push("");
  lines.push("─".repeat(60));
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

module.exports = { fetchTranscript };