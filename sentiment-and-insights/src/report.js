/**
 * Renders the coaching report as Markdown and writes JSON + Markdown to disk.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { formatClock } from "./meetstream.js";
import { balanceScore } from "./talktime.js";

/**
 * @param {object} input
 * @param {object} input.analysis
 * @param {object} input.talkTime   { source, totalSeconds, speakers }
 * @param {string} input.botId
 * @param {string} input.transcriptId
 * @param {number} input.segmentCount
 * @param {string} input.model
 * @returns {string} Markdown
 */
export function renderReport({ analysis, talkTime, botId, transcriptId, segmentCount, model }) {
  const lines = [];
  const balance = balanceScore(talkTime.speakers);

  lines.push("# Meeting insights and coaching report");
  lines.push("");
  lines.push(`- **bot_id:** \`${botId ?? "unknown"}\``);
  lines.push(`- **transcript_id:** \`${transcriptId}\``);
  lines.push(`- **Transcript segments:** ${segmentCount}`);
  lines.push(`- **Total speaking time:** ${formatClock(talkTime.totalSeconds)}`);
  lines.push(`- **Talk-time source:** ${talkTime.source}`);
  lines.push(`- **Model:** ${model}`);
  lines.push("");

  /* Overall sentiment */
  const overall = analysis.overall_sentiment;
  lines.push("## Overall sentiment");
  lines.push("");
  lines.push(`**${capitalize(overall.label)}** (${formatScore(overall.score)})`);
  if (overall.rationale) {
    lines.push("");
    lines.push(overall.rationale);
  }
  lines.push("");

  /* Sentiment over time */
  if (analysis.sentiment_timeline.length > 0) {
    lines.push("## How the mood moved");
    lines.push("");
    lines.push("| Section | Sentiment | Score | What drove it |");
    lines.push("|---------|-----------|-------|---------------|");
    for (const entry of analysis.sentiment_timeline) {
      lines.push(
        `| ${entry.section} | ${entry.label} | ${formatScore(entry.score)} | ${escapeCell(
          entry.note ?? "-"
        )} |`
      );
    }
    lines.push("");
    lines.push("```");
    for (const entry of analysis.sentiment_timeline) {
      lines.push(`Section ${entry.section}  ${sentimentBar(entry.score)}  ${formatScore(entry.score)}`);
    }
    lines.push("```");
    lines.push("");
  }

  /* Talk-time balance */
  lines.push("## Talk-time balance");
  lines.push("");
  lines.push(`Balance score: **${(balance * 100).toFixed(0)}%** (100% would be a perfectly even split)`);
  lines.push("");
  lines.push("```");
  for (const entry of talkTime.speakers) {
    const share = `${(entry.share * 100).toFixed(1)}%`.padStart(6);
    lines.push(
      `${entry.speaker.padEnd(22).slice(0, 22)} ${shareBar(entry.share)} ${share}  ` +
        `${formatClock(entry.seconds)}`
    );
  }
  lines.push("```");
  lines.push("");
  lines.push("| Speaker | Talk time | Share | Turns | Avg turn | Longest turn | Questions |");
  lines.push("|---------|-----------|-------|-------|----------|--------------|-----------|");
  for (const entry of talkTime.speakers) {
    lines.push(
      `| ${escapeCell(entry.speaker)} | ${formatClock(entry.seconds)} | ` +
        `${(entry.share * 100).toFixed(1)}% | ${entry.turns} | ${formatClock(entry.averageTurnSeconds)} | ` +
        `${formatClock(entry.longestTurnSeconds)} | ${entry.questions} |`
    );
  }
  lines.push("");

  /* Per speaker */
  if (analysis.speakers.length > 0) {
    lines.push("## By speaker");
    lines.push("");
    for (const speaker of analysis.speakers) {
      lines.push(
        `### ${speaker.name}` +
          `\n\n- Sentiment: ${speaker.sentiment.label} (${formatScore(speaker.sentiment.score)})` +
          `\n- Engagement: ${speaker.engagement}`
      );
      if (speaker.observation) lines.push(`- ${speaker.observation}`);
      lines.push("");
    }
  }

  /* Topics */
  if (analysis.topics.length > 0) {
    lines.push("## Topics");
    lines.push("");
    lines.push("| Topic | Airtime | Sentiment |");
    lines.push("|-------|---------|-----------|");
    for (const topic of analysis.topics) {
      lines.push(
        `| ${escapeCell(topic.topic)} | ${escapeCell(topic.mentions ?? "-")} | ${topic.sentiment} |`
      );
    }
    lines.push("");
  }

  /* Risks */
  if (analysis.risks.length > 0) {
    lines.push("## Risks and friction");
    lines.push("");
    for (const risk of analysis.risks) lines.push(`- ${risk}`);
    lines.push("");
  }

  /* Coaching */
  lines.push("## Coaching");
  lines.push("");
  if (analysis.coaching.length === 0) {
    lines.push("_No coaching points were produced for this meeting._");
  } else {
    analysis.coaching.forEach((point, index) => {
      lines.push(`${index + 1}. **${point.title}**`);
      if (point.detail) lines.push(`   ${point.detail}`);
    });
  }
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("Generated from a MeetStream transcript and speaker timeline.");
  lines.push("");

  return lines.join("\n");
}

/**
 * Write `<dir>/insights-<transcriptId>.json` and `.md`.
 * @returns {Promise<{ jsonPath: string, markdownPath: string }>}
 */
export async function writeOutputs({ dir, transcriptId, json, markdown }) {
  await mkdir(dir, { recursive: true });
  const base = `insights-${transcriptId}`;
  const jsonPath = join(dir, `${base}.json`);
  const markdownPath = join(dir, `${base}.md`);

  await writeFile(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdown, "utf8");

  return { jsonPath, markdownPath };
}

/* ------------------------------------------------------------------ */

function shareBar(share, width = 30) {
  const filled = Math.round(Math.max(0, Math.min(1, share)) * width);
  return `${"█".repeat(filled)}${"·".repeat(width - filled)}`;
}

/** A -1..1 score drawn around a centre line. */
function sentimentBar(score, halfWidth = 12) {
  const clamped = Math.max(-1, Math.min(1, Number(score) || 0));
  const magnitude = Math.round(Math.abs(clamped) * halfWidth);
  if (clamped < 0) {
    return `${" ".repeat(halfWidth - magnitude)}${"█".repeat(magnitude)}|${" ".repeat(halfWidth)}`;
  }
  return `${" ".repeat(halfWidth)}|${"█".repeat(magnitude)}${" ".repeat(halfWidth - magnitude)}`;
}

function formatScore(score) {
  const value = Number(score) || 0;
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function capitalize(value) {
  const text = String(value ?? "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}
