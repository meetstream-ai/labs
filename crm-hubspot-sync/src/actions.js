/**
 * Optional summary and action-item extraction.
 *
 * MeetStream gives you the transcript. Turning it into a summary or a checklist
 * needs a model, so both steps run on your own LLM. They are deliberately
 * optional: with neither OPENAI_API_KEY nor ANTHROPIC_API_KEY set they return
 * empty results and the rest of the template carries on without those sections.
 */

import { completeJson, completeText, isLlmConfigured, truncateForPrompt } from "./llm.js";
import { segmentsToPlainText } from "./meetstream.js";

const SYSTEM = `You extract action items from meeting transcripts.
Return only commitments someone actually made. Do not invent tasks.
Owner must be a speaker name that appears in the transcript, or null.
Due must be a date or relative phrase the speakers actually said, or null.`;

const SUMMARY_SYSTEM = `You summarise meeting transcripts.
Write a short plain-text summary: what was discussed and what was decided.
Use only what the speakers said. Do not invent facts, names or numbers.
Separate paragraphs with a blank line. No markdown headings.`;

/**
 * Write a plain-text summary of the meeting from its transcript.
 * @param {Array<{speaker: string, transcript: string}>} segments
 * @returns {Promise<string>} empty string when no LLM is configured
 */
export async function summarizeMeeting(segments) {
  if (!isLlmConfigured()) {
    console.log("  No LLM key set, skipping the summary. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.");
    return "";
  }
  if (segments.length === 0) return "";

  const transcript = truncateForPrompt(segmentsToPlainText(segments));
  const text = await completeText({
    system: SUMMARY_SYSTEM,
    user: `Transcript:\n${transcript}`,
    maxTokens: 800,
  });
  return text.trim();
}

/**
 * @param {Array<{speaker: string, transcript: string}>} segments
 * @param {string} [summary]
 * @returns {Promise<Array<{task: string, owner: string|null, due: string|null}>>}
 */
export async function extractActionItems(segments, summary = "") {
  if (!isLlmConfigured()) {
    console.log("  No LLM key set, skipping action items. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.");
    return [];
  }
  if (segments.length === 0) return [];

  const transcript = truncateForPrompt(segmentsToPlainText(segments));

  const user = [
    summary ? `Meeting summary:\n${summary}\n` : "",
    "Transcript:",
    transcript,
    "",
    'Return JSON of the form: {"action_items":[{"task":"...","owner":"name or null","due":"phrase or null"}]}',
    "Return an empty array if nobody committed to anything.",
  ].join("\n");

  const data = await completeJson({ system: SYSTEM, user, maxTokens: 1200 });
  const items = Array.isArray(data?.action_items) ? data.action_items : [];

  return items
    .map((item) => ({
      task: String(item?.task ?? "").trim(),
      owner: item?.owner ? String(item.owner).trim() : null,
      due: item?.due ? String(item.due).trim() : null,
    }))
    .filter((item) => item.task.length > 0);
}
