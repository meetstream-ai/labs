/**
 * Helpers for placing screenshots on the meeting timeline.
 *
 * Time values in MeetStream payloads come back either as absolute instants
 * (ISO 8601 strings or epoch seconds/milliseconds) or as offsets from the
 * start of the meeting. These helpers normalise whichever form is present and,
 * crucially, keep track of WHICH form it was - screenshots and the speaker
 * timeline can only be correlated when both use the same one.
 */

/** Keys that plausibly carry a time value, most specific first. */
export const TIME_KEYS = [
  'timestamp',
  'captured_at',
  'capture_time',
  'taken_at',
  'created_at',
  'time',
  'offset_ms',
  'offset_seconds',
  'offset',
  'elapsed_ms',
  'elapsed',
  'start_time',
  'start',
];

/**
 * Normalise a raw time value.
 *
 * @param {unknown} value
 * @returns {{ ms: number, absolute: boolean }|null}
 */
export function toMillis(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    // > ~1e12 is epoch milliseconds; > ~1e9 is epoch seconds; anything
    // smaller is an offset from the start of the meeting, in seconds.
    if (value > 1e12) return { ms: value, absolute: true };
    if (value > 1e9) return { ms: value * 1000, absolute: true };
    return { ms: value * 1000, absolute: false };
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    // "00:12:34" or "12:34" offsets
    const clock = /^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/.exec(trimmed);
    if (clock) {
      const hours = Number(clock[1] ?? 0);
      const minutes = Number(clock[2]);
      const seconds = Number(clock[3]);
      return { ms: ((hours * 60 + minutes) * 60 + seconds) * 1000, absolute: false };
    }

    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return { ms: parsed, absolute: true };

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return toMillis(numeric);
  }

  return null;
}

/**
 * Find the first recognisable time value on an object.
 *
 * @param {Record<string, unknown>} node
 * @returns {{ key: string, raw: unknown, ms: number, absolute: boolean }|null}
 */
export function extractTime(node) {
  if (!node || typeof node !== 'object') return null;
  for (const key of TIME_KEYS) {
    if (!(key in node)) continue;
    const normalized = toMillis(node[key]);
    if (normalized) return { key, raw: node[key], ...normalized };
  }
  return null;
}

/**
 * Flatten a speaker-timeline response into comparable entries.
 *
 * `GET /bots/{bot_id}/get_speaker_timeline` returns either a top-level array
 * of turns or an object wrapping one. Each turn carries a speaker name and a
 * start (and usually an end).
 *
 * @param {any} data
 * @returns {{ entries: Array<{ speaker: string, startMs: number, endMs: number|null }>, absolute: boolean|null }}
 */
export function normalizeSpeakerTimeline(data) {
  const rows = findFirstArray(data);
  /** @type {Array<{ speaker: string, startMs: number, endMs: number|null }>} */
  const entries = [];
  let absolute = null;

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;

    const speaker =
      row.speaker ??
      row.participant_name ??
      row.participant?.name ??
      row.name ??
      row.speaker_name ??
      null;

    const start = toMillis(row.start ?? row.start_time ?? row.from ?? row.begin ?? row.timestamp);
    if (!speaker || !start) continue;

    const end = toMillis(row.end ?? row.end_time ?? row.to ?? row.finish);
    if (absolute === null) absolute = start.absolute;

    entries.push({
      speaker: String(speaker),
      startMs: start.ms,
      endMs: end ? end.ms : null,
    });
  }

  entries.sort((a, b) => a.startMs - b.startMs);
  return { entries, absolute };
}

/**
 * Who was speaking at a given instant.
 *
 * @param {Array<{ speaker: string, startMs: number, endMs: number|null }>} entries
 * @param {number} ms
 * @returns {string|null}
 */
export function speakerAt(entries, ms) {
  let candidate = null;
  for (const entry of entries) {
    if (entry.startMs > ms) break;
    candidate = entry;
  }
  if (!candidate) return null;
  // The turn ended before this instant: nobody was speaking (silence/gap).
  if (candidate.endMs !== null && candidate.endMs < ms) return null;
  return candidate.speaker;
}

/**
 * @param {number} ms
 * @returns {string} "H:MM:SS"
 */
export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${hours}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Depth-first search for the first non-empty array in an arbitrary payload.
 *
 * @param {unknown} data
 * @returns {any[]}
 */
function findFirstArray(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const value of Object.values(data)) {
    if (Array.isArray(value) && value.length) return value;
  }
  for (const value of Object.values(data)) {
    if (value && typeof value === 'object') {
      const nested = findFirstArray(value);
      if (nested.length) return nested;
    }
  }
  return [];
}
