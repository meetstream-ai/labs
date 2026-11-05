/**
 * Talk-time balance.
 *
 * Preferred source is `GET /bots/{id}/get_speaker_timeline`, which is real
 * measured speaking time. If that is unavailable (202, empty, or an older
 * recording), we fall back to estimating from the transcript, and the report
 * says which source was used so nobody mistakes an estimate for a measurement.
 */

import { getSpeakerTimeline, normalizeSpeakerTimeline } from "./meetstream.js";

/** Words per minute used when estimating speaking time from text alone. */
const ESTIMATE_WPM = 150;

/**
 * @param {string|null} botId
 * @param {Array<{speaker: string, transcript: string, start_time: number|null, end_time: number|null}>} segments
 * @returns {Promise<{ source: string, totalSeconds: number, speakers: Array<object> }>}
 */
export async function computeTalkTime(botId, segments) {
  const stats = new Map();

  const ensure = (speaker) => {
    if (!stats.has(speaker)) {
      stats.set(speaker, {
        speaker,
        seconds: 0,
        turns: 0,
        words: 0,
        questions: 0,
        longestTurnSeconds: 0,
      });
    }
    return stats.get(speaker);
  };

  /* Text-derived stats are always useful, whatever the timing source is. */
  for (const segment of segments) {
    const entry = ensure(segment.speaker);
    entry.turns += 1;
    entry.words += countWords(segment.transcript);
    entry.questions += (segment.transcript.match(/\?/g) || []).length;
  }

  /* 1. Real speaker timeline. */
  let source = "get_speaker_timeline";
  let timeline = [];
  if (botId) {
    try {
      const payload = await getSpeakerTimeline(botId);
      timeline = normalizeSpeakerTimeline(payload);
    } catch (error) {
      console.warn(`  get_speaker_timeline failed: ${error.message}`);
    }
  }

  if (timeline.length > 0) {
    for (const entry of timeline) {
      const stat = ensure(entry.speaker);
      stat.seconds += entry.duration;
      stat.longestTurnSeconds = Math.max(stat.longestTurnSeconds, entry.duration);
    }
  } else {
    /* 2. Transcript segment timings, if the provider supplied them. */
    const timed = segments.filter(
      (segment) => segment.start_time != null && segment.end_time != null && segment.end_time > segment.start_time
    );

    if (timed.length > 0) {
      source = "transcript segment timings";
      for (const segment of timed) {
        const duration = segment.end_time - segment.start_time;
        const stat = ensure(segment.speaker);
        stat.seconds += duration;
        stat.longestTurnSeconds = Math.max(stat.longestTurnSeconds, duration);
      }
    } else {
      /* 3. Word-count estimate. Clearly labelled as an estimate in the report. */
      source = `estimated from word count at ${ESTIMATE_WPM} wpm`;
      for (const segment of segments) {
        const duration = (countWords(segment.transcript) / ESTIMATE_WPM) * 60;
        const stat = ensure(segment.speaker);
        stat.seconds += duration;
        stat.longestTurnSeconds = Math.max(stat.longestTurnSeconds, duration);
      }
    }
  }

  const speakers = [...stats.values()];
  const totalSeconds = speakers.reduce((sum, entry) => sum + entry.seconds, 0);

  for (const entry of speakers) {
    entry.seconds = Math.round(entry.seconds);
    entry.longestTurnSeconds = Math.round(entry.longestTurnSeconds);
    entry.share = totalSeconds > 0 ? entry.seconds / totalSeconds : 0;
    entry.averageTurnSeconds = entry.turns > 0 ? Math.round(entry.seconds / entry.turns) : 0;
  }

  speakers.sort((a, b) => b.seconds - a.seconds);

  return { source, totalSeconds: Math.round(totalSeconds), speakers };
}

/**
 * Balance score, 0 to 1. 1 means everyone spoke equally.
 * Uses normalised entropy, which is stable across different speaker counts.
 */
export function balanceScore(speakers) {
  const shares = speakers.map((entry) => entry.share).filter((share) => share > 0);
  if (shares.length <= 1) return shares.length === 1 ? 0 : 1;
  const entropy = -shares.reduce((sum, share) => sum + share * Math.log(share), 0);
  return entropy / Math.log(shares.length);
}

function countWords(text) {
  return String(text ?? "").trim().split(/\s+/).filter(Boolean).length;
}

export { ESTIMATE_WPM };
