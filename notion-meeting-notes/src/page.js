/**
 * Turns a MeetStream meeting into the Notion block list for one page.
 *
 * Layout:
 *   callout   provenance (bot id, transcript id, segment count)
 *   Summary   paragraphs from GET /bots/{id}/summary
 *   Participants  bullets
 *   Action items  to_do checkboxes
 *   Transcript    one paragraph per speaker turn, inside a collapsed toggle
 */

import { formatClock } from "./meetstream.js";
import { bullet, callout, divider, heading, paragraph, todo, toggle } from "./notion.js";

/** Merge consecutive segments from the same speaker into one readable turn. */
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
 * @param {string} input.summary
 * @param {string[]} input.participants
 * @param {Array<{task: string, owner: string|null, due: string|null}>} input.actionItems
 * @param {Array<{speaker: string, transcript: string, start_time: number|null}>} input.segments
 * @param {string} input.botId
 * @param {string} input.transcriptId
 * @param {number} [input.maxTranscriptTurns]
 * @returns {Array<object>} Notion blocks
 */
export function buildMeetingBlocks({
  summary,
  participants = [],
  actionItems = [],
  segments = [],
  botId,
  transcriptId,
  maxTranscriptTurns = 400,
}) {
  const blocks = [];

  blocks.push(
    callout(
      `Recorded with MeetStream\nbot_id: ${botId ?? "unknown"}\ntranscript_id: ${transcriptId}\n` +
        `${segments.length} transcript segments`
    )
  );

  blocks.push(heading("Summary"));
  if (summary) {
    for (const block of summary.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)) {
      blocks.push(paragraph(block));
    }
  } else {
    blocks.push(paragraph("No AI summary was available for this meeting."));
  }

  blocks.push(heading("Participants"));
  if (participants.length > 0) {
    for (const person of participants) blocks.push(bullet(person));
  } else {
    blocks.push(paragraph("The meeting platform did not report a participant list."));
  }

  blocks.push(heading("Action items"));
  if (actionItems.length > 0) {
    for (const item of actionItems) {
      const owner = item.owner ? ` (${item.owner}` : "";
      const due = item.due ? `${owner ? ", due " : " (due "}${item.due}` : "";
      const suffix = owner || due ? `${owner}${due})` : "";
      blocks.push(todo(`${item.task}${suffix}`));
    }
  } else {
    blocks.push(paragraph("No action items were extracted. Set an LLM key to enable extraction."));
  }

  blocks.push(divider(), heading("Transcript"));

  const turns = groupTurns(segments);
  const shown = turns.slice(0, maxTranscriptTurns);
  const omitted = turns.length - shown.length;

  if (shown.length === 0) {
    blocks.push(paragraph("(empty transcript)"));
  } else {
    // The first 100 turns go inside a collapsed toggle so the page stays scannable.
    const inToggle = shown.slice(0, 100).map((turn) => paragraph(formatTurn(turn)));
    blocks.push(toggle(`Full transcript (${turns.length} speaker turns)`, inToggle));

    // Anything beyond the toggle's 100-child limit is appended after it.
    for (const turn of shown.slice(100)) blocks.push(paragraph(formatTurn(turn)));
  }

  if (omitted > 0) blocks.push(paragraph(`(+${omitted} more speaker turns omitted)`));

  return blocks;
}

function formatTurn(turn) {
  const stamp = turn.start_time != null ? `[${formatClock(turn.start_time)}] ` : "";
  return `${stamp}${turn.speaker}: ${turn.transcript}`;
}
