/**
 * Building a meeting digest from MeetStream's post-call transcript.
 *
 * MeetStream does not generate summaries server side. This module fetches the
 * transcript and computes a local, deterministic digest from it: talk share per
 * speaker and the opening lines. For a written summary, pass the segments to
 * your own LLM.
 *
 *   GET /bots/{bot_id}/detail                         -> bot_details.transcript_id
 *   GET /transcript/{transcript_id}/get_transcript    -> segments (202 while processing)
 */

import { envInt, pollUntilReady } from './client.js';

/** Read a poll setting, accepting the older SUMMARY_POLL_* names as a fallback. */
function pollSetting(name, legacyName, fallback) {
  return envInt(name, envInt(legacyName, fallback));
}

/**
 * Fetch the post-call transcript for a bot and return normalised segments.
 * @param {import('./client.js').MeetStreamClient} client
 * @param {string} botId
 * @returns {Promise<{ transcriptId: string, segments: Array<{speaker: string, transcript: string}>, attempts: number }>}
 */
export async function fetchTranscript(client, botId) {
  const { data: detail } = await client.getDetail(botId);
  const transcriptId = detail?.bot_details?.transcript_id ?? detail?.transcript_id ?? null;
  if (!transcriptId) {
    throw new Error(
      `Bot ${botId} has no transcript_id. That happens when the bot used a streaming-only\n` +
        'transcription provider (no post-call transcript), or never recorded any audio.'
    );
  }

  const maxAttempts = pollSetting('TRANSCRIPT_POLL_MAX_ATTEMPTS', 'SUMMARY_POLL_MAX_ATTEMPTS', 30);
  const intervalMs = pollSetting('TRANSCRIPT_POLL_INTERVAL_MS', 'SUMMARY_POLL_INTERVAL_MS', 10_000);

  const { data, attempts } = await pollUntilReady(() => client.getTranscript(transcriptId), {
    intervalMs,
    maxAttempts,
    label: 'The transcript',
    onWait: (attempt) =>
      console.log(
        `  transcript still processing (HTTP 202) - attempt ${attempt}/${maxAttempts}, ` +
          `retrying in ${Math.round(intervalMs / 1000)}s`
      ),
  });

  return { transcriptId, segments: extractSegments(data), attempts };
}

/** Normalise a get_transcript payload into `{ speaker, transcript }` segments. */
export function extractSegments(payload) {
  const list =
    [payload, payload?.transcript, payload?.segments, payload?.data].find(Array.isArray) ?? [];
  return list
    .map((segment) => {
      if (typeof segment === 'string') return { speaker: 'Unknown speaker', transcript: segment.trim() };
      const speaker = segment?.speaker ?? segment?.speaker_name ?? 'Unknown speaker';
      // `transcript` is the real field; `text` is a tolerant fallback.
      const text = typeof segment?.transcript === 'string' ? segment.transcript : segment?.text;
      return { speaker: String(speaker), transcript: String(text ?? '').trim() };
    })
    .filter((segment) => segment.transcript.length > 0);
}

/**
 * Compute a local digest: per-speaker words, turns and share, plus opening lines.
 * @param {Array<{speaker: string, transcript: string}>} segments
 * @param {{ openingLines?: number }} [opts]
 */
export function buildDigest(segments, { openingLines = 10 } = {}) {
  const stats = new Map();
  let totalWords = 0;
  let turns = 0;
  let previous = null;

  for (const { speaker, transcript } of segments) {
    const words = transcript.split(/\s+/).filter(Boolean).length;
    const entry = stats.get(speaker) ?? { speaker, words: 0, turns: 0 };
    entry.words += words;
    if (speaker !== previous) {
      entry.turns += 1;
      turns += 1;
    }
    stats.set(speaker, entry);
    totalWords += words;
    previous = speaker;
  }

  const speakers = [...stats.values()]
    .map((s) => ({ ...s, share: totalWords > 0 ? s.words / totalWords : 0 }))
    .sort((a, b) => b.words - a.words);

  return {
    segment_count: segments.length,
    turns,
    total_words: totalWords,
    speakers,
    opening: segments.slice(0, openingLines).map(({ speaker, transcript }) => ({ speaker, transcript })),
  };
}
