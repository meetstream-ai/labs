/**
 * A meeting brief built from the transcript.
 *
 * MeetStream has no summary endpoint. The brief comes from the post-call
 * transcript: `GET /bots/{bot_id}/detail` gives the `transcript_id` (with
 * `GET /bots/{bot_id}/transcriptions` as the fallback), then
 * `GET /transcript/{transcript_id}/get_transcript` returns the segments. That
 * endpoint answers HTTP 202 while the transcript is processing, so this module
 * polls with a hard cap rather than looping forever.
 *
 * Segments are `{ speaker, transcript, start_time, end_time }`: the text is in
 * `transcript`, not `text`. For a written summary, hand the segments to your
 * own LLM.
 */

import { envInt, pollUntilReady, MeetStreamError } from './client.js';

/**
 * @param {import('./client.js').MeetStreamClient} client
 * @param {string} botId
 * @returns {Promise<{ raw: any, body: any, attempts: number }>}
 */
export async function fetchSummary(client, botId) {
  const maxAttempts = envInt('SUMMARY_POLL_MAX_ATTEMPTS', 30);
  const intervalMs = envInt('SUMMARY_POLL_INTERVAL_MS', 10_000);

  const transcriptId = await resolveTranscriptId(client, botId);
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

  const segments = extractSegments(data);
  return { raw: data, body: buildBrief(botId, transcriptId, segments), attempts };
}

/** transcript_id from the bot detail, else the newest finished transcription run. */
async function resolveTranscriptId(client, botId) {
  const { data: detail } = await client.getDetail(botId);
  const fromDetail = detail?.bot_details?.transcript_id ?? detail?.transcript_id;
  if (fromDetail) return fromDetail;

  const { data } = await client.getTranscriptions(botId);
  const runs = Array.isArray(data?.transcriptions) ? data.transcriptions : [];
  const done = runs.filter((run) => /success|completed/i.test(String(run?.status ?? '')));
  const id = (done[0] ?? runs[0])?.transcript_id;
  if (!id) {
    throw new MeetStreamError(
      404,
      'This bot has no post-call transcript. Create bots with a post-call provider ' +
        '(for example meetstream or deepgram), or run transcribe_audio on the stored audio.',
      null
    );
  }
  return id;
}

/** Flatten a get_transcript payload into `{ speaker, transcript, start_time, end_time }`. */
export function extractSegments(payload) {
  const list =
    [payload, payload?.transcript, payload?.segments, payload?.data, payload?.message].find(
      Array.isArray
    ) ?? [];
  return list
    .map((segment) => ({
      speaker: String(segment?.speaker ?? 'Unknown speaker'),
      transcript: String(segment?.transcript ?? '').trim(),
      start_time: Number.isFinite(Number(segment?.start_time)) ? Number(segment.start_time) : null,
      end_time: Number.isFinite(Number(segment?.end_time)) ? Number(segment.end_time) : null,
    }))
    .filter((segment) => segment.transcript.length > 0);
}

/** A short brief: length, speakers by share of words, opening lines. */
export function buildBrief(botId, transcriptId, segments) {
  const words = new Map();
  let end = 0;
  for (const segment of segments) {
    const count = segment.transcript.split(/\s+/).filter(Boolean).length;
    words.set(segment.speaker, (words.get(segment.speaker) || 0) + count);
    end = Math.max(end, segment.end_time || 0);
  }
  const total = [...words.values()].reduce((a, b) => a + b, 0) || 1;
  return {
    summary:
      segments.length === 0
        ? 'The transcript is empty: nobody spoke, or the provider returned no text.'
        : `${segments.length} transcript segments, about ${Math.round(end / 60)} minutes.`,
    speakers: [...words.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([speaker, count]) => `${speaker}: ${Math.round((100 * count) / total)}% of words`),
    opening: segments.slice(0, 5).map((segment) => `${segment.speaker}: ${segment.transcript}`),
    bot_id: botId,
    transcript_id: transcriptId,
  };
}
