/**
 * Pretty-print the local meeting digest built in summary.js.
 */

import { bar, heading, percent, table, wrap } from './format.js';

/**
 * @param {ReturnType<import('./summary.js').buildDigest>} digest
 * @param {{ width?: number }} [opts]
 * @returns {string}
 */
export function renderDigest(digest, { width = 88 } = {}) {
  const out = [heading('Meeting Digest')];

  if (digest.segment_count === 0) {
    out.push('');
    out.push(
      wrap(
        'The transcript came back empty. Nobody spoke, or the provider produced no text.',
        width
      )
    );
    return out.join('\n');
  }

  out.push('');
  out.push(
    `${digest.speakers.length} speaker${digest.speakers.length === 1 ? '' : 's'}, ` +
      `${digest.turns} turns, ${digest.total_words} words.`
  );

  out.push(heading('Talk Share (by words)'));
  out.push('');
  out.push(
    table(
      ['Speaker', 'Words', 'Turns', 'Share', ''],
      digest.speakers.map((s) => [s.speaker, s.words, s.turns, percent(s.share), bar(s.share, 20)]),
      { align: ['left', 'right', 'right', 'right', 'left'] }
    )
  );

  out.push(heading('Opening Lines'));
  out.push('');
  for (const { speaker, transcript } of digest.opening) {
    out.push(wrap(`${speaker}: ${transcript}`, width));
  }

  return out.join('\n');
}
