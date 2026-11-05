/**
 * Block Kit builders.
 *
 * Slack's limits, which this file respects:
 *   - 50 blocks per message
 *   - 3000 characters per section `text`
 *   - 150 characters per header `text` (plain_text only, no mrkdwn)
 *   - 10 elements per context block
 */

const SECTION_LIMIT = 2900;
const MAX_BLOCKS = 48;

/** Escape the three characters Slack mrkdwn cares about. */
export function escapeMrkdwn(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function header(text) {
  return { type: "header", text: { type: "plain_text", text: truncate(text, 150), emoji: true } };
}

export function section(mrkdwn) {
  return { type: "section", text: { type: "mrkdwn", text: truncate(mrkdwn, SECTION_LIMIT) } };
}

export function context(mrkdwn) {
  return { type: "context", elements: [{ type: "mrkdwn", text: truncate(mrkdwn, SECTION_LIMIT) }] };
}

export const divider = () => ({ type: "divider" });

/**
 * Build the main summary message.
 *
 * @param {object} input
 * @param {string} input.title
 * @param {string} input.summary
 * @param {Array<{task: string, owner: string|null, due: string|null}>} input.actionItems
 * @param {string[]} input.participants
 * @param {string} input.botId
 * @param {number} input.segmentCount
 * @returns {{ text: string, blocks: Array }}
 */
export function buildSummaryMessage({
  title,
  summary,
  actionItems = [],
  participants = [],
  botId,
  segmentCount = 0,
}) {
  const blocks = [header(title)];

  if (participants.length > 0) {
    blocks.push(context(`*Participants:* ${escapeMrkdwn(participants.join(", "))}`));
  }

  blocks.push(divider());

  if (summary) {
    blocks.push(section("*Summary*"));
    for (const chunk of chunkText(escapeMrkdwn(summary), SECTION_LIMIT)) {
      blocks.push(section(chunk));
    }
  } else {
    blocks.push(section("*Summary*\n_No AI summary was available for this meeting._"));
  }

  if (actionItems.length > 0) {
    blocks.push(divider(), section("*Action items*"));
    const lines = actionItems.map((item, index) => {
      const owner = item.owner ? ` - *${escapeMrkdwn(item.owner)}*` : "";
      const due = item.due ? ` _(due ${escapeMrkdwn(item.due)})_` : "";
      return `${index + 1}. ${escapeMrkdwn(item.task)}${owner}${due}`;
    });
    for (const chunk of chunkLines(lines, SECTION_LIMIT)) {
      blocks.push(section(chunk));
    }
  }

  blocks.push(
    divider(),
    context(
      `Recorded with MeetStream  |  bot \`${escapeMrkdwn(botId ?? "unknown")}\`  |  ` +
        `${segmentCount} transcript segments`
    )
  );

  return {
    text: `${title}${summary ? `\n\n${summary.slice(0, 400)}` : ""}`,
    blocks: blocks.slice(0, MAX_BLOCKS),
  };
}

/**
 * Build the threaded transcript reply (bot-token mode only).
 * @param {Array<{speaker: string, transcript: string}>} turns
 */
export function buildTranscriptMessage(turns, maxTurns = 60) {
  const shown = turns.slice(0, maxTurns);
  const omitted = turns.length - shown.length;

  const lines = shown.map(
    (turn) => `*${escapeMrkdwn(turn.speaker)}:* ${escapeMrkdwn(turn.transcript)}`
  );

  const blocks = [section("*Full transcript*")];
  for (const chunk of chunkLines(lines, SECTION_LIMIT)) {
    blocks.push(section(chunk));
    if (blocks.length >= MAX_BLOCKS - 1) break;
  }
  if (omitted > 0) blocks.push(context(`_+${omitted} more speaker turns omitted._`));

  return { text: "Full transcript", blocks: blocks.slice(0, MAX_BLOCKS) };
}

/* ------------------------------------------------------------------ */

function truncate(value, limit) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Split a blob of text into <= limit sized chunks, preferring paragraph breaks. */
export function chunkText(text, limit) {
  const chunks = [];
  let remaining = String(text ?? "").trim();
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = remaining.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.length > 0 ? chunks : [""];
}

/** Pack whole lines into <= limit sized chunks. */
export function chunkLines(lines, limit) {
  const chunks = [];
  let current = "";
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      if (current) chunks.push(current);
      current = line.length > limit ? truncate(line, limit) : line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
