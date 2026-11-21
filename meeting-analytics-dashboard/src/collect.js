/**
 * Gather everything MeetStream knows about one meeting.
 *
 * Five read endpoints are fetched independently:
 *
 *   GET /bots/{id}/detail                 session metadata + status timeline
 *   GET /bots/{id}/get_participants       roster (top-level array)
 *   GET /bots/{id}/get_speaker_timeline   who spoke when
 *   GET /bots/{id}/get_chats              in-meeting chat
 *   GET /transcript/{tid}/get_transcript  post-call transcript -> a short brief
 *
 * MeetStream has no summary endpoint: the "summary" section is a brief built
 * from the transcript. Any one of them can legitimately be unavailable for a
 * given bot - a bot with a streaming-only transcript provider has no post-call
 * transcript, a meeting where
 * nobody typed has no chat. So each section records its own outcome instead
 * of one failure sinking the whole report.
 */

import { pollUntilReady } from './client.js';

/**
 * @typedef {{ status: 'ok'|'processing'|'missing'|'error', data: any, note: string|null, httpStatus: number|null }} Section
 */

/** @returns {Section} */
function ok(data) {
  return { status: 'ok', data, note: null, httpStatus: 200 };
}

/** @returns {Section} */
function failed(err, missingNote) {
  if (err?.status === 404) {
    return { status: 'missing', data: null, note: missingNote, httpStatus: 404 };
  }
  if (err?.status === 202) {
    return { status: 'processing', data: null, note: err.message, httpStatus: 202 };
  }
  return { status: 'error', data: null, note: err?.message ?? String(err), httpStatus: err?.status ?? null };
}

/**
 * Fetch one section, polling through 202s up to a cap.
 *
 * @param {() => Promise<{status:number,data:any}>} fn
 * @param {{ label: string, missingNote: string, intervalMs: number, maxAttempts: number, onLog: (msg: string) => void }} opts
 * @returns {Promise<Section>}
 */
async function section(fn, { label, missingNote, intervalMs, maxAttempts, onLog }) {
  try {
    const { data } = await pollUntilReady(fn, {
      intervalMs,
      maxAttempts,
      label,
      onWait: (attempt) => onLog(`  ${label}: still processing (202), ${attempt}/${maxAttempts}`),
    });
    onLog(`  ${label}: ok`);
    return ok(data);
  } catch (err) {
    const result = failed(err, missingNote);
    onLog(`  ${label}: ${result.status}${result.note ? ` - ${result.note}` : ''}`);
    return result;
  }
}

/**
 * @param {import('./client.js').MeetStreamClient} client
 * @param {string} botId
 * @param {{ intervalMs?: number, maxAttempts?: number, onLog?: (msg: string) => void }} [opts]
 */
export async function collectMeeting(client, botId, { intervalMs = 10_000, maxAttempts = 12, onLog = () => {} } = {}) {
  const common = { intervalMs, maxAttempts, onLog };

  // Sequential rather than parallel: five simultaneous poll loops against the
  // same bot is a good way to get rate limited for no benefit.
  const detail = await section(() => client.getDetail(botId), {
    label: 'detail',
    missingNote: 'No bot with this id, or its data has been deleted.',
    ...common,
  });

  const participants = await section(() => client.getParticipants(botId), {
    label: 'participants',
    missingNote: 'No participant roster stored for this bot.',
    ...common,
  });

  const speakerTimeline = await section(() => client.getSpeakerTimeline(botId), {
    label: 'speaker timeline',
    missingNote: 'No speaker timeline - the bot may not have recorded any audio.',
    ...common,
  });

  const chats = await section(() => client.getChats(botId), {
    label: 'chats',
    missingNote: 'No chat captured for this meeting.',
    ...common,
  });

  const noTranscript =
    'No post-call transcript for this bot, so no brief. Briefs need a post-call ' +
    'transcript provider; streaming-only providers do not produce one.';
  const transcriptId = meetingMeta(detail)?.transcript_id;
  const transcript = transcriptId
    ? await section(() => client.getTranscript(transcriptId), {
        label: 'transcript',
        missingNote: noTranscript,
        ...common,
      })
    : { status: 'missing', data: null, note: noTranscript, httpStatus: null };
  const summary =
    transcript.status === 'ok' ? { ...transcript, data: briefFromTranscript(transcript.data) } : transcript;

  return { botId, detail, participants, speakerTimeline, chats, summary };
}

/** A short brief from transcript segments: length, speakers by share of words, opening lines. */
export function briefFromTranscript(payload) {
  const list =
    [payload, payload?.transcript, payload?.segments, payload?.data, payload?.message].find(
      Array.isArray
    ) ?? [];
  const segments = list
    .map((s) => ({ speaker: String(s?.speaker ?? 'Unknown speaker'), text: String(s?.transcript ?? '').trim(), end: Number(s?.end_time) || 0 }))
    .filter((s) => s.text);
  const words = new Map();
  let end = 0;
  for (const s of segments) {
    words.set(s.speaker, (words.get(s.speaker) || 0) + s.text.split(/\s+/).length);
    end = Math.max(end, s.end);
  }
  const total = [...words.values()].reduce((a, b) => a + b, 0) || 1;
  return {
    summary: `${segments.length} transcript segments, about ${Math.round(end / 60)} minutes. Brief built from the transcript.`,
    speakers: [...words.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([speaker, count]) => `${speaker}: ${Math.round((100 * count) / total)}% of words`)
      .join('; '),
    opening: segments.slice(0, 3).map((s) => `${s.speaker}: ${s.text}`).join(' / '),
  };
}

/** Pull the useful bits out of the `{ bot_details: {...} }` envelope. */
export function meetingMeta(detailSection) {
  const d = detailSection?.data?.bot_details;
  if (!d) return null;
  return {
    bot_id: d.BotID ?? null,
    bot_name: d.BotUsername ?? null,
    meeting_link: d.MeetingLink ?? null,
    platform: d.Platform ?? null,
    status: d.Status ?? null,
    created_at: d.CreatedAt ?? null,
    start_time: d.StartTime ?? null,
    end_time: d.EndTime ?? null,
    duration: d.Duration ?? null,
    audio_status: d.AudioStatus ?? null,
    transcript_status: d.TranscriptStatus ?? null,
    manifest_status: d.ManifestStatus ?? null,
    transcript_id: d.transcript_id ?? null,
    custom_attributes: d.custom_attributes ?? null,
    status_timeline: d.StatusTimeline ?? null,
  };
}

/** Normalise the participant roster (a top-level array) into report rows. */
export function participantRows(participantsSection) {
  const list = participantsSection?.data;
  if (!Array.isArray(list)) return [];
  return list.map((p) => ({
    device_id: p.deviceId ?? null,
    name: p.fullName || p.displayName || 'Unknown',
    display_name: p.displayName ?? null,
    status: p.humanized_status ?? (p.status !== undefined ? String(p.status) : null),
    stream_count: Array.isArray(p.streamIds) ? p.streamIds.length : 0,
    last_updated: p.lastUpdated ?? null,
    is_screenshare: Boolean(p.parentDeviceId),
    parent_device_id: p.parentDeviceId ?? null,
  }));
}

/** Reached lifecycle stages from StatusTimeline, in the order the API returned. */
export function reachedStages(meta) {
  const timeline = meta?.status_timeline;
  if (!timeline || typeof timeline !== 'object') return [];
  return Object.entries(timeline)
    .filter(([, v]) => v && typeof v === 'object' && v.status === true)
    .map(([stage, v]) => ({ stage, message: v.message ?? null, timestamp: v.timestamp ?? null }));
}
