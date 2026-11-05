/**
 * Rendering the speaker-attributed transcript and the talk-time table.
 */

import fs from "node:fs";
import path from "node:path";

import { formatTime } from "./format.js";

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

/** Clean, speaker-attributed transcript. */
export function renderSpeakerTranscript(turns) {
  const lines = [];
  for (const turn of turns) {
    const start = turn.startTime != null ? formatTime(turn.startTime) : "--:--";
    const end = turn.endTime != null ? formatTime(turn.endTime) : "--:--";
    lines.push("");
    lines.push(`[${start} - ${end}]  ${turn.speaker}`);
    lines.push(...wrap(turn.transcript, 76, "    "));
  }
  return lines.join("\n");
}

/** Fixed-width talk-time table with a bar per speaker. */
export function renderStatsTable(stats) {
  if (stats.length === 0) return "(no speakers)";

  const nameWidth = Math.max(8, ...stats.map((entry) => entry.speaker.length));
  const basis = stats[0].shareBasis === "time" ? "share of talk time" : "share of words";

  const header =
    `${"Speaker".padEnd(nameWidth)}  ${"Turns".padStart(6)}  ${"Words".padStart(7)}  ` +
    `${"Time".padStart(9)}  ${basis}`;
  const lines = [header, "-".repeat(header.length + 12)];

  for (const entry of stats) {
    const pct = Math.round(entry.share * 100);
    const bar = "#".repeat(Math.round(entry.share * 24));
    lines.push(
      `${entry.speaker.padEnd(nameWidth)}  ${String(entry.turns).padStart(6)}  ` +
        `${String(entry.words).padStart(7)}  ${formatTime(entry.seconds).padStart(9)}  ` +
        `${String(pct).padStart(3)}%  ${bar}`,
    );
  }
  return lines.join("\n");
}

/**
 * Write three files:
 *   <stem>-raw.json      the untouched API response
 *   <stem>-turns.json    turns + per-speaker stats
 *   <stem>-speakers.txt  the readable speaker-attributed transcript
 */
export function saveReport(outputDir, stem, rawPayload, turns, stats) {
  fs.mkdirSync(outputDir, { recursive: true });

  const rawPath = path.join(outputDir, `${stem}-raw.json`);
  fs.writeFileSync(rawPath, `${JSON.stringify(rawPayload, null, 2)}\n`, "utf8");

  const turnsPath = path.join(outputDir, `${stem}-turns.json`);
  fs.writeFileSync(
    turnsPath,
    `${JSON.stringify({ speakers: stats, turns }, null, 2)}\n`,
    "utf8",
  );

  const header = [
    "SPEAKER-ATTRIBUTED TRANSCRIPT",
    `generated: ${new Date().toISOString()}`,
    `speakers:  ${stats.length}`,
    `turns:     ${turns.length}`,
    "",
    renderStatsTable(stats),
    "-".repeat(78),
  ].join("\n");

  const textPath = path.join(outputDir, `${stem}-speakers.txt`);
  fs.writeFileSync(textPath, `${header}\n${renderSpeakerTranscript(turns)}\n`, "utf8");

  return { rawPath, turnsPath, textPath };
}
