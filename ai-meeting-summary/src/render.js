/**
 * Pretty-print the meeting brief that src/summary.js builds from the
 * transcript (MeetStream has no summary endpoint).
 *
 * The renderer walks the object generically: brief keys (summary, speakers,
 * opening) are surfaced first, ids second, and bulky fields are hidden unless
 * you ask for them.
 */

import { heading, titleize, wrap, timestamp } from './format.js';

/** Keys whose content is most likely to be the actual summary. Shown first. */
const PRIORITY_PATTERNS = [
  /summary/i,
  /speaker/i,
  /opening/i,
  /overview/i,
  /abstract/i,
  /key.?point/i,
  /highlight/i,
  /action.?item/i,
  /next.?step/i,
  /decision/i,
  /topic/i,
  /agenda/i,
  /question/i,
  /sentiment/i,
];

/** Bulky or purely internal fields, hidden unless SHOW_ALL_FIELDS=true. */
const NOISY_KEYS = new Set([
  'RequestPayload',
  'StatusTimeline',
  'BotImageURL',
  'BotProfile',
  'MediaS3Bucket',
  'UserID',
  'participant_events',
]);

function priorityRank(key) {
  const index = PRIORITY_PATTERNS.findIndex((re) => re.test(key));
  return index === -1 ? PRIORITY_PATTERNS.length : index;
}

const TIMESTAMP_KEYS = /(^|_)(at|time|timestamp)$|CreatedAt$|UpdatedAt$|StartTime$|EndTime$/i;

function renderScalar(key, value) {
  if (typeof value === 'string' && TIMESTAMP_KEYS.test(key)) {
    return timestamp(value) ?? value;
  }
  return String(value);
}

function isScalar(v) {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

/**
 * Render a value at a given indent depth.
 * @returns {string[]} lines
 */
function renderValue(value, depth, width) {
  const pad = '  '.repeat(depth);

  if (value === null || value === undefined) return [`${pad}(none)`];

  if (typeof value === 'string') {
    return wrap(value, width - pad.length, pad).split('\n');
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return [`${pad}${value}`];
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}(empty list)`];
    const lines = [];
    for (const item of value) {
      if (isScalar(item)) {
        const text = wrap(String(item), width - pad.length - 2, '').split('\n');
        lines.push(`${pad}- ${text[0]}`);
        for (const extra of text.slice(1)) lines.push(`${pad}  ${extra}`);
      } else {
        lines.push(`${pad}-`);
        lines.push(...renderValue(item, depth + 1, width));
      }
    }
    return lines;
  }

  // Plain object
  const entries = Object.entries(value).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (entries.length === 0) return [`${pad}(empty)`];
  const lines = [];
  for (const [k, v] of entries) {
    if (isScalar(v)) {
      lines.push(`${pad}${titleize(k)}: ${renderScalar(k, v)}`);
    } else {
      lines.push(`${pad}${titleize(k)}:`);
      lines.push(...renderValue(v, depth + 1, width));
    }
  }
  return lines;
}

/**
 * @param {any} body the brief from src/summary.js
 * @param {{ showAll?: boolean, width?: number }} [opts]
 * @returns {string}
 */
export function renderSummary(body, { showAll = false, width = 88 } = {}) {
  if (body === null || body === undefined) return '(the API returned an empty body)';

  if (typeof body === 'string') {
    return `${heading('Meeting Brief')}\n\n${wrap(body, width)}`;
  }

  if (Array.isArray(body)) {
    return `${heading('Meeting Brief')}\n${renderValue(body, 0, width).join('\n')}`;
  }

  const keys = Object.keys(body).filter((k) => showAll || !NOISY_KEYS.has(k));
  const populated = keys.filter((k) => {
    const v = body[k];
    if (v === null || v === undefined || v === '') return false;
    if (Array.isArray(v) && v.length === 0) return false;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return false;
    return true;
  });

  if (populated.length === 0) {
    return (
      `${heading('Meeting Brief')}\n\n` +
      'Every field of the brief was empty: the meeting produced no transcript to\n' +
      'summarise. The raw JSON has still been written to disk.'
    );
  }

  populated.sort((a, b) => {
    const rank = priorityRank(a) - priorityRank(b);
    return rank !== 0 ? rank : a.localeCompare(b);
  });

  const summaryKeys = populated.filter((k) => priorityRank(k) < PRIORITY_PATTERNS.length);
  const metaKeys = populated.filter((k) => priorityRank(k) === PRIORITY_PATTERNS.length);

  const out = [];

  out.push(heading('Meeting Brief'));
  if (summaryKeys.length === 0) {
    out.push('');
    out.push(
      wrap(
        'No summary-shaped fields were present in the response. Everything the API ' +
          'returned is listed under Session Details below, and the full payload is on disk.',
        width
      )
    );
  }
  for (const key of summaryKeys) {
    out.push('');
    out.push(`${titleize(key)}`);
    out.push('-'.repeat(titleize(key).length));
    out.push(...renderValue(body[key], 0, width));
  }

  if (metaKeys.length > 0) {
    out.push(heading('Session Details'));
    out.push('');
    for (const key of metaKeys) {
      const v = body[key];
      if (isScalar(v)) {
        out.push(`${titleize(key)}: ${renderScalar(key, v)}`);
      } else {
        out.push(`${titleize(key)}:`);
        out.push(...renderValue(v, 1, width));
      }
    }
  }

  return out.join('\n');
}
