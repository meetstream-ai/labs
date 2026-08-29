/**
 * Post-processing a diarized transcript into per-speaker turns.
 *
 * With `diarize: true`, Deepgram attributes speech to speakers. That shows up
 * in the MeetStream transcript in two places:
 *
 *   - segment.speaker  - the segment's speaker (a display name when MeetStream
 *                        can map the diarized speaker to a meeting participant,
 *                        otherwise a numeric index)
 *   - segment.words[].speaker - the per-word speaker index, plus
 *                        speaker_confidence
 *
 * Diarization output is segment-level, and a single continuous stretch of one
 * person talking often arrives as several segments. What you usually want is
 * TURNS: consecutive segments from the same speaker, merged, split whenever
 * someone else talks or the same speaker resumes after a long pause.
 */

const UNKNOWN = "Unknown speaker";

/** Majority `words[].speaker` index for a segment, or null. */
function majorityWordSpeaker(words) {
  const counts = new Map();
  for (const word of words) {
    if (typeof word?.speaker !== "number" || !Number.isFinite(word.speaker)) continue;
    counts.set(word.speaker, (counts.get(word.speaker) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  let best = null;
  let bestCount = -1;
  for (const [speaker, count] of counts) {
    if (count > bestCount) {
      best = speaker;
      bestCount = count;
    }
  }
  return best;
}

/** Mean `speaker_confidence` across a segment's words, or null. */
function meanSpeakerConfidence(words) {
  const values = words
    .map((word) => word?.speaker_confidence)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Fill in a speaker for segments that arrived without one, using the word-level
 * diarization labels. Leaves already-labelled segments alone.
 */
export function enrichSpeakers(segments) {
  return segments.map((segment) => {
    const confidence = meanSpeakerConfidence(segment.words);

    if (segment.speaker !== UNKNOWN) {
      return { ...segment, speakerConfidence: confidence };
    }

    const index = majorityWordSpeaker(segment.words);
    return {
      ...segment,
      speaker: index === null ? UNKNOWN : `Speaker ${index}`,
      speakerConfidence: confidence,
    };
  });
}

/**
 * Merge consecutive segments from the same speaker into turns.
 *
 * A turn ends when a different speaker starts, or when the same speaker resumes
 * after a gap longer than `maxGapSeconds` (so a long pause reads as a new turn
 * rather than one endless paragraph).
 *
 * @param {Array} segments
 * @param {{ maxGapSeconds?: number }} [options]
 */
export function buildTurns(segments, options = {}) {
  const { maxGapSeconds = 8 } = options;
  const turns = [];

  for (const segment of segments) {
    const previous = turns[turns.length - 1];

    const sameSpeaker = previous && previous.speaker === segment.speaker;
    const gap =
      previous && previous.endTime != null && segment.startTime != null
        ? segment.startTime - previous.endTime
        : 0;
    const withinGap = gap <= maxGapSeconds;

    if (sameSpeaker && withinGap) {
      previous.transcript = `${previous.transcript} ${segment.transcript}`.trim();
      previous.endTime = segment.endTime ?? previous.endTime;
      previous.segmentCount += 1;
      previous.wordCount += countWords(segment.transcript);
      if (segment.speakerConfidence != null) {
        previous.confidenceSamples.push(segment.speakerConfidence);
      }
    } else {
      turns.push({
        speaker: segment.speaker,
        transcript: segment.transcript,
        startTime: segment.startTime,
        endTime: segment.endTime,
        segmentCount: 1,
        wordCount: countWords(segment.transcript),
        confidenceSamples: segment.speakerConfidence != null ? [segment.speakerConfidence] : [],
      });
    }
  }

  // Collapse the confidence samples into a single mean per turn.
  return turns.map((turn) => {
    const { confidenceSamples, ...rest } = turn;
    const confidence =
      confidenceSamples.length > 0
        ? confidenceSamples.reduce((sum, value) => sum + value, 0) / confidenceSamples.length
        : null;
    return { ...rest, speakerConfidence: confidence };
  });
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Per-speaker totals: turns, words, speaking time, and share of speaking time.
 *
 * Speaking time is the sum of turn durations, which needs `start_time` and
 * `end_time` on the segments. When those are absent the durations come out as
 * 0 and the share falls back to word count, which is still a usable proxy.
 */
export function speakerStats(turns) {
  const byspeaker = new Map();

  for (const turn of turns) {
    const entry = byspeaker.get(turn.speaker) ?? {
      speaker: turn.speaker,
      turns: 0,
      words: 0,
      seconds: 0,
    };
    entry.turns += 1;
    entry.words += turn.wordCount;
    if (turn.startTime != null && turn.endTime != null && turn.endTime > turn.startTime) {
      entry.seconds += turn.endTime - turn.startTime;
    }
    byspeaker.set(turn.speaker, entry);
  }

  const stats = [...byspeaker.values()];
  const totalSeconds = stats.reduce((sum, entry) => sum + entry.seconds, 0);
  const totalWords = stats.reduce((sum, entry) => sum + entry.words, 0);

  for (const entry of stats) {
    entry.share =
      totalSeconds > 0
        ? entry.seconds / totalSeconds
        : totalWords > 0
          ? entry.words / totalWords
          : 0;
    entry.shareBasis = totalSeconds > 0 ? "time" : "words";
  }

  stats.sort((a, b) => b.share - a.share);
  return stats;
}
