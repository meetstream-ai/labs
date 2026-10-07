/**
 * LLM analysis of a MeetStream transcript: sentiment, topics, risks, coaching.
 *
 * The transcript is split into equal thirds (or `SENTIMENT_BUCKETS` chunks) so
 * the model can report how the mood moved over the meeting rather than giving
 * one flat verdict.
 */

import { completeJson, describeLlm, truncateForPrompt } from "./llm.js";
import { segmentsToPlainText } from "./meetstream.js";

const SYSTEM = `You analyse meeting transcripts and produce coaching feedback.

Rules:
- Ground every observation in what was actually said. Never invent events.
- "score" fields are numbers from -1 (very negative) to 1 (very positive).
- Speaker names must come from the speaker list you are given.
- Be specific and useful. "Communication could be better" is worthless; say what to do differently.
- If the transcript is too thin to judge something, say so rather than guessing.`;

const SENTIMENT_LABELS = new Set(["positive", "neutral", "negative", "mixed"]);

/**
 * @param {object} input
 * @param {Array<{speaker: string, transcript: string}>} input.segments
 * @param {string} [input.summary]
 * @param {Array<object>} input.talkTimeSpeakers
 * @returns {Promise<object>}
 */
export async function analyzeTranscript({ segments, summary = "", talkTimeSpeakers = [] }) {
  const speakers = [...new Set(segments.map((segment) => segment.speaker))];
  const buckets = chunkIntoBuckets(segments, Number(process.env.SENTIMENT_BUCKETS || 3));

  const bucketText = buckets
    .map(
      (bucket, index) =>
        `--- Section ${index + 1} of ${buckets.length} ---\n` +
        truncateForPrompt(
          segmentsToPlainText(bucket),
          Math.floor(Number(process.env.LLM_MAX_TRANSCRIPT_CHARS || 60000) / buckets.length)
        )
    )
    .join("\n\n");

  const talkTimeLines = talkTimeSpeakers
    .map(
      (entry) =>
        `${entry.speaker}: ${Math.round(entry.share * 100)}% of speaking time, ` +
        `${entry.turns} turns, ${entry.questions} questions asked`
    )
    .join("\n");

  const user = [
    `Speakers: ${speakers.join(", ")}`,
    "",
    talkTimeLines ? `Measured talk time:\n${talkTimeLines}\n` : "",
    summary ? `Meeting summary:\n${summary}\n` : "",
    "Transcript, split into sections in chronological order:",
    bucketText,
    "",
    "Return JSON shaped exactly like this:",
    JSON.stringify(
      {
        overall_sentiment: { label: "positive | neutral | negative | mixed", score: 0, rationale: "string" },
        sentiment_timeline: [{ section: 1, label: "positive", score: 0, note: "what drove it" }],
        speakers: [
          {
            name: "speaker name",
            sentiment: { label: "positive", score: 0 },
            engagement: "high | medium | low",
            observation: "one specific, evidence-based observation",
          },
        ],
        topics: [{ topic: "string", mentions: "roughly how much airtime", sentiment: "positive" }],
        risks: ["concerns, objections or unresolved friction raised in the meeting"],
        coaching: [
          { title: "short imperative", detail: "what to do differently next time, and why" },
        ],
      },
      null,
      2
    ),
  ].join("\n");

  console.log(`Running analysis with ${describeLlm()} over ${buckets.length} sections...`);

  const data = await completeJson({
    system: SYSTEM,
    user,
    maxTokens: Number(process.env.LLM_MAX_TOKENS || 3000),
  });

  return normalize(data, speakers, buckets.length);
}

/** Split segments into N chronological buckets of roughly equal size. */
export function chunkIntoBuckets(segments, count) {
  const buckets = Math.max(1, Math.min(count || 3, Math.max(1, segments.length)));
  const size = Math.ceil(segments.length / buckets);
  const out = [];
  for (let i = 0; i < segments.length; i += size) out.push(segments.slice(i, i + size));
  return out.length > 0 ? out : [[]];
}

function normalize(data, speakers, bucketCount) {
  const knownSpeakers = new Map(speakers.map((name) => [name.toLowerCase(), name]));

  return {
    overall_sentiment: normalizeSentiment(data?.overall_sentiment),
    sentiment_timeline: Array.isArray(data?.sentiment_timeline)
      ? data.sentiment_timeline.slice(0, bucketCount).map((entry, index) => ({
          section: Number(entry?.section) || index + 1,
          ...normalizeSentiment(entry),
          note: entry?.note ? String(entry.note).trim() : null,
        }))
      : [],
    speakers: Array.isArray(data?.speakers)
      ? data.speakers
          .map((entry) => {
            const raw = String(entry?.name ?? "").trim();
            if (!raw) return null;
            return {
              name: knownSpeakers.get(raw.toLowerCase()) ?? raw,
              sentiment: normalizeSentiment(entry?.sentiment),
              engagement: ["high", "medium", "low"].includes(String(entry?.engagement).toLowerCase())
                ? String(entry.engagement).toLowerCase()
                : "medium",
              observation: entry?.observation ? String(entry.observation).trim() : null,
            };
          })
          .filter(Boolean)
      : [],
    topics: Array.isArray(data?.topics)
      ? data.topics
          .map((entry) => ({
            topic: String(entry?.topic ?? "").trim(),
            mentions: entry?.mentions ? String(entry.mentions).trim() : null,
            sentiment: normalizeLabel(entry?.sentiment),
          }))
          .filter((entry) => entry.topic)
      : [],
    risks: toStringArray(data?.risks),
    coaching: Array.isArray(data?.coaching)
      ? data.coaching
          .map((entry) => ({
            title: String(entry?.title ?? "").trim(),
            detail: entry?.detail ? String(entry.detail).trim() : null,
          }))
          .filter((entry) => entry.title)
      : [],
  };
}

function normalizeSentiment(value) {
  const score = Number(value?.score);
  return {
    label: normalizeLabel(value?.label),
    score: Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : 0,
    rationale: value?.rationale ? String(value.rationale).trim() : null,
  };
}

function normalizeLabel(value) {
  const label = String(value ?? "").toLowerCase().trim();
  return SENTIMENT_LABELS.has(label) ? label : "neutral";
}

function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}
