/**
 * Rendering and persisting a transcript.
 */

import fs from "node:fs";
import path from "node:path";

/** Seconds → mm:ss (or h:mm:ss for long meetings). */
export function formatTime(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "--:--";
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Word-wrap `text` to `width` columns, indenting continuation lines. */
function wrap(text, width, indent) {
  const lines = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    if (current && current.length + word.length + 1 > width) {
      lines.push(indent + current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(indent + current);
  return lines;
}

export function renderTranscript(turns) {
  const lines = [];
  for (const turn of turns) {
    const stamp = turn.startTime != null ? `[${formatTime(turn.startTime)}] ` : "";
    lines.push("");
    lines.push(`${stamp}${turn.speaker}`);
    lines.push(...wrap(turn.transcript, 76, "    "));
  }
  return lines.join("\n");
}

/**
 * Write the raw JSON and a human-readable .txt next to each other.
 * @returns {{ jsonPath: string, textPath: string }}
 */
export function saveTranscript(outputDir, transcriptId, rawPayload, turns) {
  fs.mkdirSync(outputDir, { recursive: true });

  const jsonPath = path.join(outputDir, `${transcriptId}.json`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(rawPayload, null, 2)}\n`, "utf8");

  const header = [
    "MEETING TRANSCRIPT",
    `transcript_id: ${transcriptId}`,
    `generated:     ${new Date().toISOString()}`,
    `turns:         ${turns.length}`,
    "-".repeat(78),
  ].join("\n");

  const textPath = path.join(outputDir, `${transcriptId}.txt`);
  fs.writeFileSync(textPath, `${header}\n${renderTranscript(turns)}\n`, "utf8");

  return { jsonPath, textPath };
}
