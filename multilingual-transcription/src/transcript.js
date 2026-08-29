/**
 * Fetching and parsing a MeetStream transcript.
 *
 * Endpoint: GET /transcript/{transcript_id}/get_transcript?raw=false
 *   - keyed by transcript_id, NOT bot_id
 *   - HTTP 202 means "still processing" - poll again, with a cap
 *   - the processed response is an ARRAY of segments
 *
 * Segment shape:
 *   {
 *     "speaker": "Alice",
 *     "transcript": "Can you walk me through pricing?",   <-- NOT "text"
 *     "start_time": 12.4,
 *     "end_time": 15.1,
 *     "words": [ { "word", "punctuated_word", "start", "end", "confidence",
 *                  "speaker", "speaker_confidence" } ]
 *   }
 *
 * The single most common integration bug is reading `segment.text`. That field
 * does not exist and you get a transcript full of `undefined`. The field is
 * `segment.transcript`.
 */

import { api, sleep } from "./client.js";

/**
 * Fetch a transcript, polling while the API returns 202.
 *
 * @param {string} transcriptId
 * @param {object} [options]
 * @param {boolean} [options.raw]         true → provider-raw output
 * @param {number} [options.maxAttempts]  hard cap on polls (default 24)
 * @param {number} [options.intervalMs]   delay between polls (default 5000)
 * @param {(attempt: number, max: number) => void} [options.onWait]
 * @returns {Promise<any>} parsed JSON body
 */
export async function fetchTranscript(transcriptId, options = {}) {
  const { raw = false, maxAttempts = 24, intervalMs = 5000, onWait } = options;
  const path = `/transcript/${encodeURIComponent(transcriptId)}/get_transcript?raw=${raw}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 202 is an expected outcome here, not an error - let it through.
    const { status, data } = await api(path, { acceptStatuses: [202] });

    if (status !== 202) return data;

    if (onWait) onWait(attempt, maxAttempts);
    if (attempt < maxAttempts) await sleep(intervalMs);
  }

  throw new Error(
    `Transcript ${transcriptId} still returned HTTP 202 after ${maxAttempts} attempts ` +
      `(~${Math.round((maxAttempts * intervalMs) / 1000)}s).\n` +
      "A transcript that never leaves 202 usually means the bot used a *_streaming\n" +
      "provider. Streaming-only bots deliver transcripts live and never produce a\n" +
      "post-call transcript, so this endpoint returns 202 forever. Always cap retries.",
  );
}

/** Turn a raw `speaker` value into a display label. */
function speakerLabel(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  // Diarization can emit numeric speaker indexes when no name is available.
  if (typeof value === "number" && Number.isFinite(value)) return `Speaker ${value}`;
  return "Unknown speaker";
}

/**
 * Normalise the API response into a flat array of segments.
 *
 * The processed endpoint returns a bare array. We also accept the array nested
 * under `transcript` / `segments` so that this parser keeps working if you pipe
 * a wrapped payload (for example one you stored yourself) through it.
 */
export function parseSegments(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.transcript)
      ? payload.transcript
      : Array.isArray(payload?.segments)
        ? payload.segments
        : [];

  return list
    .map((segment) => ({
      speaker: speakerLabel(segment?.speaker),
      // The text lives in `transcript`. There is no `text` field.
      transcript: typeof segment?.transcript === "string" ? segment.transcript.trim() : "",
      startTime: typeof segment?.start_time === "number" ? segment.start_time : null,
      endTime: typeof segment?.end_time === "number" ? segment.end_time : null,
      words: Array.isArray(segment?.words) ? segment.words : [],
    }))
    .filter((segment) => segment.transcript.length > 0);
}

/** Merge consecutive segments from the same speaker into readable turns. */
export function toSpeakerTurns(segments) {
  const turns = [];
  for (const segment of segments) {
    const previous = turns[turns.length - 1];
    if (previous && previous.speaker === segment.speaker) {
      previous.transcript = `${previous.transcript} ${segment.transcript}`.trim();
      previous.endTime = segment.endTime ?? previous.endTime;
      previous.segmentCount += 1;
    } else {
      turns.push({ ...segment, segmentCount: 1 });
    }
  }
  return turns;
}
