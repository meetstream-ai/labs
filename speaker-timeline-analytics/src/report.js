/**
 * Render speaker analytics for a terminal.
 */

import { bar, bytes, duration, heading, percent, table, timestamp } from './format.js';

const NAME_WIDTH = 24;

function clip(name) {
  const s = String(name ?? 'Unknown');
  return s.length <= NAME_WIDTH ? s : `${s.slice(0, NAME_WIDTH - 1)}…`;
}

/**
 * @param {ReturnType<import('./analytics.js').analyzeTimeline>} stats
 * @param {{ botId: string, barWidth?: number }} opts
 */
export function renderReport(stats, { botId, barWidth = 30 }) {
  const out = [];

  out.push(heading(`Speaker Analytics - bot ${botId}`));
  out.push('');

  if (stats.chunkCount === 0) {
    out.push('The speaker timeline is empty. Nothing was attributed to a speaker.');
    out.push('');
    out.push('Common reasons:');
    out.push('  - the bot never made it into the meeting (check GET /bots/{id}/status)');
    out.push('  - nobody spoke while the bot was recording');
    out.push('  - the recording is still being processed - re-run in a minute');
    return out.join('\n');
  }

  // --- Headline ----------------------------------------------------------
  const headline = [
    ['Speakers', String(stats.speakers.length)],
    ['Speaking turns', String(stats.turnCount)],
    ['Timeline chunks', String(stats.chunkCount)],
    ['Total speech', stats.secondsAvailable ? duration(stats.totalSeconds) : bytes(stats.totalBytes)],
  ];
  if (stats.audioSeconds !== null) headline.push(['Recording length', duration(stats.audioSeconds)]);
  if (stats.silenceSeconds !== null) {
    const share = stats.audioSeconds > 0 ? stats.silenceSeconds / stats.audioSeconds : 0;
    headline.push(['Silence / non-speech', `${duration(stats.silenceSeconds)} (${percent(share)})`]);
  }
  headline.push(['Overlapping starts', String(stats.overlapCount)]);
  if (stats.lastUpdated) headline.push(['Timeline last updated', timestamp(stats.lastUpdated)]);

  out.push(table(['Metric', 'Value'], headline));

  // --- Talk-time share ---------------------------------------------------
  out.push(heading('Talk-time share'));
  out.push('');
  for (const s of stats.speakers) {
    const label = clip(s.name).padEnd(NAME_WIDTH);
    const time = stats.secondsAvailable ? duration(s.seconds) : bytes(s.bytes);
    out.push(`${label} ${bar(s.share, barWidth)} ${percent(s.share).padStart(6)}  ${time}`);
  }

  // --- Per-speaker breakdown --------------------------------------------
  out.push(heading('Per speaker'));
  out.push('');
  out.push(
    table(
      ['Speaker', 'Talk time', 'Share', 'Turns', 'Avg turn', 'Longest turn', 'Talked over'],
      stats.speakers.map((s) => [
        clip(s.name),
        stats.secondsAvailable ? duration(s.seconds) : bytes(s.bytes),
        percent(s.share),
        String(s.turns),
        stats.secondsAvailable ? duration(s.averageTurnSeconds) : '-',
        stats.secondsAvailable ? duration(s.longestTurnSeconds) : bytes(s.longestTurnBytes),
        String(s.interruptions ?? 0),
      ]),
      { align: ['left', 'right', 'right', 'right', 'right', 'right', 'right'] }
    )
  );

  // --- Longest monologue -------------------------------------------------
  if (stats.longestMonologue) {
    const m = stats.longestMonologue;
    out.push(heading('Longest monologue'));
    out.push('');
    out.push(`${m.speaker} held the floor for ${stats.secondsAvailable ? duration(m.seconds) : bytes(m.bytes)}`);
    out.push(`across ${m.chunks} consecutive timeline chunk${m.chunks === 1 ? '' : 's'}.`);
    if (m.timestamp) out.push(`Turn started around ${timestamp(m.timestamp)}.`);
    out.push(`Audio byte range: ${m.startByte}-${m.endByte}`);
  }

  // --- Overlaps ----------------------------------------------------------
  out.push(heading('Overlapping speech'));
  out.push('');
  if (stats.overlapCount === 0) {
    out.push('No overlapping turns detected - speakers waited for each other.');
  } else {
    out.push(
      `${stats.overlapCount} turn${stats.overlapCount === 1 ? '' : 's'} started before the previous`
    );
    out.push('speaker had finished. Ranked by who did it most:');
    out.push('');
    const counts = new Map();
    for (const o of stats.overlaps) {
      counts.set(o.interrupter, (counts.get(o.interrupter) || 0) + 1);
    }
    out.push(
      table(
        ['Speaker', 'Overlapping starts'],
        [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([name, count]) => [clip(name), String(count)]),
        { align: ['left', 'right'] }
      )
    );
  }

  // --- Method note -------------------------------------------------------
  out.push(heading('How these numbers were derived'));
  out.push('');
  out.push('The timeline gives byte offsets into the recorded audio file, not timestamps.');
  if (stats.secondsAvailable) {
    out.push(
      `Seconds are computed as bytes / (${stats.sampleRate} Hz × bytesPerSample × channels), ` +
        'using the'
    );
    out.push('16-bit mono PCM defaults. Percentages are exact either way: they are byte ratios,');
    out.push('so the conversion constant cancels out.');
  } else {
    out.push('No usable sampleRate was present on any chunk, so absolute durations cannot be');
    out.push('computed. Shares and byte counts are still exact.');
  }

  return out.join('\n');
}
