/**
 * LLM extraction of action items from a MeetStream transcript.
 *
 * The model is told the meeting date so it can resolve relative phrases like
 * "by Friday" into a real ISO date, and it is told the speaker list so owners
 * come back as real names rather than invented ones.
 */

import { completeJson, describeLlm, truncateForPrompt } from "./llm.js";
import { segmentsToPlainText } from "./meetstream.js";

const SYSTEM = `You extract action items from meeting transcripts.

Rules:
- Only include commitments someone actually made or was clearly assigned. Never invent work.
- "owner" must be one of the speaker names given to you, or null if it is genuinely unclear.
- "due_raw" is the phrase the speakers used, verbatim, or null.
- "due_date" is that phrase resolved against the meeting date, as YYYY-MM-DD, or null if it cannot be resolved.
- "priority" is one of "high", "medium", "low" based on the urgency expressed in the conversation.
- "evidence" is a short verbatim quote from the transcript that shows the commitment.
- If nobody committed to anything, return an empty array.`;

const PRIORITIES = new Set(["high", "medium", "low"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {object} input
 * @param {Array<{speaker: string, transcript: string}>} input.segments
 * @param {string} [input.summary]
 * @param {Date} [input.meetingDate]
 * @returns {Promise<{ action_items: Array<object>, decisions: string[], open_questions: string[] }>}
 */
export async function extractActionItems({ segments, summary = "", meetingDate = new Date() }) {
  if (segments.length === 0) {
    return { action_items: [], decisions: [], open_questions: [] };
  }

  const speakers = [...new Set(segments.map((segment) => segment.speaker))];
  const transcript = truncateForPrompt(segmentsToPlainText(segments));
  const isoMeetingDate = meetingDate.toISOString().slice(0, 10);

  const user = [
    `Meeting date: ${isoMeetingDate} (${meetingDate.toLocaleDateString("en-US", { weekday: "long" })})`,
    `Speakers: ${speakers.join(", ")}`,
    "",
    summary ? `Summary:\n${summary}\n` : "",
    "Transcript:",
    transcript,
    "",
    "Return JSON shaped exactly like this:",
    JSON.stringify(
      {
        action_items: [
          {
            task: "string",
            owner: "speaker name or null",
            due_raw: "phrase they said or null",
            due_date: "YYYY-MM-DD or null",
            priority: "high | medium | low",
            evidence: "short verbatim quote",
          },
        ],
        decisions: ["decisions the group actually reached"],
        open_questions: ["questions raised and left unresolved"],
      },
      null,
      2
    ),
  ].join("\n");

  console.log(`Running extraction with ${describeLlm()}...`);

  const data = await completeJson({
    system: SYSTEM,
    user,
    maxTokens: Number(process.env.LLM_MAX_TOKENS || 2500),
  });

  return {
    action_items: normalizeItems(data?.action_items, speakers),
    decisions: normalizeStrings(data?.decisions),
    open_questions: normalizeStrings(data?.open_questions),
  };
}

function normalizeItems(value, speakers) {
  if (!Array.isArray(value)) return [];

  const knownSpeakers = new Map(speakers.map((name) => [name.toLowerCase(), name]));

  return value
    .map((item) => {
      const task = String(item?.task ?? "").trim();
      if (!task) return null;

      // Snap the owner back to a real speaker name where we can.
      let owner = item?.owner ? String(item.owner).trim() : null;
      if (owner) owner = knownSpeakers.get(owner.toLowerCase()) ?? owner;

      const dueDate = item?.due_date ? String(item.due_date).trim() : null;

      return {
        task,
        owner: owner || null,
        due_raw: item?.due_raw ? String(item.due_raw).trim() : null,
        due_date: dueDate && ISO_DATE.test(dueDate) ? dueDate : null,
        priority: PRIORITIES.has(String(item?.priority).toLowerCase())
          ? String(item.priority).toLowerCase()
          : "medium",
        evidence: item?.evidence ? String(item.evidence).trim() : null,
      };
    })
    .filter(Boolean);
}

function normalizeStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}
