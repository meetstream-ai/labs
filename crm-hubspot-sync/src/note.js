/**
 * Builds the HTML body for the HubSpot note.
 *
 * HubSpot renders `hs_note_body` as rich text, so a small subset of HTML works:
 * headings, paragraphs, bold, lists, line breaks. Keep it simple - HubSpot
 * strips anything exotic.
 */

import { formatClock } from "./meetstream.js";

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** Merge consecutive segments from the same speaker into one turn. */
export function groupTurns(segments) {
  const turns = [];
  for (const segment of segments) {
    const previous = turns[turns.length - 1];
    if (previous && previous.speaker === segment.speaker) {
      previous.transcript += ` ${segment.transcript}`;
    } else {
      turns.push({ ...segment });
    }
  }
  return turns;
}

/**
 * @param {object} input
 * @param {string} input.title
 * @param {string} input.summary
 * @param {Array<{task: string, owner: string|null, due: string|null}>} input.actionItems
 * @param {string[]} input.participants
 * @param {Array<{speaker: string, transcript: string, start_time: number|null}>} input.segments
 * @param {string} input.botId
 * @param {string} input.transcriptId
 * @param {boolean} input.includeTranscript
 * @param {number} input.maxTurns
 * @returns {string} HTML
 */
export function buildNoteBody({
  title,
  summary,
  actionItems = [],
  participants = [],
  segments = [],
  botId,
  transcriptId,
  includeTranscript = true,
  maxTurns = 200,
}) {
  const parts = [`<h2>${escapeHtml(title)}</h2>`];

  if (participants.length > 0) {
    parts.push(`<p><strong>Participants:</strong> ${escapeHtml(participants.join(", "))}</p>`);
  }

  parts.push("<h3>Summary</h3>");
  if (summary) {
    for (const block of summary.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)) {
      parts.push(`<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`);
    }
  } else {
    parts.push("<p><em>No AI summary was available for this meeting.</em></p>");
  }

  if (actionItems.length > 0) {
    parts.push("<h3>Action items</h3><ul>");
    for (const item of actionItems) {
      const owner = item.owner ? ` <strong>(${escapeHtml(item.owner)})</strong>` : "";
      const due = item.due ? ` <em>due ${escapeHtml(item.due)}</em>` : "";
      parts.push(`<li>${escapeHtml(item.task)}${owner}${due}</li>`);
    }
    parts.push("</ul>");
  }

  if (includeTranscript) {
    const turns = groupTurns(segments);
    const shown = turns.slice(0, maxTurns);
    const omitted = turns.length - shown.length;

    parts.push("<h3>Transcript</h3>");
    if (shown.length === 0) {
      parts.push("<p><em>(empty transcript)</em></p>");
    } else {
      for (const turn of shown) {
        const stamp = turn.start_time != null ? `[${formatClock(turn.start_time)}] ` : "";
        parts.push(
          `<p>${escapeHtml(stamp)}<strong>${escapeHtml(turn.speaker)}:</strong> ${escapeHtml(
            turn.transcript
          )}</p>`
        );
      }
    }
    if (omitted > 0) parts.push(`<p><em>+${omitted} more speaker turns omitted.</em></p>`);
  }

  parts.push(
    `<p><em>Recorded with MeetStream. bot_id ${escapeHtml(botId ?? "unknown")}, ` +
      `transcript_id ${escapeHtml(transcriptId)}.</em></p>`
  );

  return parts.join("\n");
}
