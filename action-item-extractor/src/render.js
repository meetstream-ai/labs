/**
 * Renders the extraction result as Markdown, and writes both the JSON and the
 * Markdown to disk.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

/** Sort by priority, then by due date, then by owner. Undated items go last. */
export function sortActionItems(items) {
  return [...items].sort((a, b) => {
    const priority = (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1);
    if (priority !== 0) return priority;
    if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date);
    if (a.due_date) return -1;
    if (b.due_date) return 1;
    return String(a.owner ?? "").localeCompare(String(b.owner ?? ""));
  });
}

/**
 * @param {object} input
 * @param {object} input.result   { action_items, decisions, open_questions }
 * @param {string} input.botId
 * @param {string} input.transcriptId
 * @param {Date}   input.meetingDate
 * @param {number} input.segmentCount
 * @returns {string} Markdown
 */
export function renderMarkdown({ result, botId, transcriptId, meetingDate, segmentCount }) {
  const items = sortActionItems(result.action_items);
  const lines = [];

  lines.push(`# Action items`);
  lines.push("");
  lines.push(`- **Meeting date:** ${meetingDate.toISOString().slice(0, 10)}`);
  lines.push(`- **bot_id:** \`${botId ?? "unknown"}\``);
  lines.push(`- **transcript_id:** \`${transcriptId}\``);
  lines.push(`- **Transcript segments:** ${segmentCount}`);
  lines.push("");

  if (items.length === 0) {
    lines.push("_No action items were extracted from this meeting._");
    lines.push("");
  } else {
    lines.push("| # | Task | Owner | Due | Priority |");
    lines.push("|---|------|-------|-----|----------|");
    items.forEach((item, index) => {
      const due = item.due_date ?? item.due_raw ?? "-";
      lines.push(
        `| ${index + 1} | ${escapeCell(item.task)} | ${escapeCell(item.owner ?? "unassigned")} | ` +
          `${escapeCell(due)} | ${item.priority} |`
      );
    });
    lines.push("");

    lines.push("## Checklist");
    lines.push("");
    for (const item of items) {
      const owner = item.owner ? ` **@${item.owner}**` : "";
      const due = item.due_date ? ` _(due ${item.due_date})_` : item.due_raw ? ` _(${item.due_raw})_` : "";
      lines.push(`- [ ]${owner} ${item.task}${due}`);
      if (item.evidence) lines.push(`  > ${item.evidence}`);
    }
    lines.push("");
  }

  if (result.decisions.length > 0) {
    lines.push("## Decisions");
    lines.push("");
    for (const decision of result.decisions) lines.push(`- ${decision}`);
    lines.push("");
  }

  if (result.open_questions.length > 0) {
    lines.push("## Open questions");
    lines.push("");
    for (const question of result.open_questions) lines.push(`- ${question}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("Extracted from a MeetStream transcript.");
  lines.push("");

  return lines.join("\n");
}

/**
 * Write `<dir>/action-items-<transcriptId>.json` and `.md`.
 * @returns {Promise<{ jsonPath: string, markdownPath: string }>}
 */
export async function writeOutputs({ dir, transcriptId, json, markdown }) {
  await mkdir(dir, { recursive: true });
  const base = `action-items-${transcriptId}`;
  const jsonPath = join(dir, `${base}.json`);
  const markdownPath = join(dir, `${base}.md`);

  await writeFile(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdown, "utf8");

  return { jsonPath, markdownPath };
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}
