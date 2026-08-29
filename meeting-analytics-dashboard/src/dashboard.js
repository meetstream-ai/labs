/**
 * Build the consolidated meeting report: a JSON object, a Markdown document,
 * and a terminal dashboard, all from the same collected data.
 */

import { bar, bytes, duration, heading, percent, table, timestamp, titleize } from './format.js';
import { analyzeTimeline } from './analytics.js';
import { normalizeChats, authorCounts } from './normalize.js';
import { meetingMeta, participantRows, reachedStages } from './collect.js';

/** Short label for the data-sources table. */
const STATUS_LABEL = {
  ok: 'ok',
  processing: 'still processing',
  missing: 'not available',
  error: 'error',
};

/** Longer phrase for "this section is missing because …" lines. */
const STATUS_PHRASE = {
  processing: 'still processing when the poll cap was reached',
  missing: 'not available for this bot',
  error: 'unavailable because the request failed',
};

function why(status) {
  return STATUS_PHRASE[status] ?? status;
}

/**
 * @param {Awaited<ReturnType<import('./collect.js').collectMeeting>>} collected
 * @param {{ bytesPerSample?: number, channels?: number }} [opts]
 */
export function buildReport(collected, { bytesPerSample = 2, channels = 1 } = {}) {
  const meta = meetingMeta(collected.detail);
  const participants = participantRows(collected.participants);
  const speech =
    collected.speakerTimeline.status === 'ok'
      ? analyzeTimeline(collected.speakerTimeline.data, { bytesPerSample, channels })
      : null;
  const chat = collected.chats.status === 'ok' ? normalizeChats(collected.chats.data) : null;

  const sections = {
    detail: collected.detail.status,
    participants: collected.participants.status,
    speaker_timeline: collected.speakerTimeline.status,
    chats: collected.chats.status,
    summary: collected.summary.status,
  };

  return {
    bot_id: collected.botId,
    generated_at: new Date().toISOString(),
    sections,
    section_notes: Object.fromEntries(
      Object.entries({
        detail: collected.detail.note,
        participants: collected.participants.note,
        speaker_timeline: collected.speakerTimeline.note,
        chats: collected.chats.note,
        summary: collected.summary.note,
      }).filter(([, v]) => v)
    ),
    meeting: meta,
    lifecycle: reachedStages(meta),
    participants: {
      count: participants.filter((p) => !p.is_screenshare).length,
      screenshares: participants.filter((p) => p.is_screenshare).length,
      roster: participants,
    },
    speech: speech
      ? {
          assumptions: {
            bytes_per_sample: bytesPerSample,
            channels,
            sample_rate: speech.sampleRate,
            note: 'startByte/endByte are byte offsets into the audio file, not time offsets.',
          },
          speakers: speech.speakers,
          turn_count: speech.turnCount,
          chunk_count: speech.chunkCount,
          speech_seconds: speech.totalSeconds,
          speech_bytes: speech.totalBytes,
          recording_seconds: speech.audioSeconds,
          silence_seconds: speech.silenceSeconds,
          longest_monologue: speech.longestMonologue,
          overlapping_starts: speech.overlapCount,
          overlaps: speech.overlaps,
        }
      : null,
    chat: chat
      ? {
          message_count: chat.total,
          by_author: authorCounts(chat.messages).map(([author, count]) => ({ author, count })),
          field_mapping: chat.keysUsed,
          unmapped_fields: chat.unmapped,
          messages: chat.messages.map(({ index, author, text, timestamp: ts, recipient }) => ({
            index,
            author,
            text,
            timestamp: ts,
            recipient,
          })),
        }
      : null,
    summary: collected.summary.status === 'ok' ? unwrapSummary(collected.summary.data) : null,
    raw: {
      detail: collected.detail.data,
      participants: collected.participants.data,
      speaker_timeline: collected.speakerTimeline.data,
      chats: collected.chats.data,
      summary: collected.summary.data,
    },
  };
}

function unwrapSummary(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.bot_details) {
    return payload.bot_details;
  }
  return payload;
}

/** Keys inside the summary payload most likely to hold actual summary text. */
const SUMMARY_PATTERNS = [
  /summary/i,
  /overview/i,
  /key.?point/i,
  /action.?item/i,
  /next.?step/i,
  /decision/i,
  /topic/i,
  /highlight/i,
];

function summaryHighlights(summary) {
  if (!summary) return [];
  if (typeof summary === 'string') return [['Summary', summary]];
  if (typeof summary !== 'object') return [];
  return Object.entries(summary).filter(([k, v]) => {
    if (v === null || v === undefined || v === '') return false;
    if (Array.isArray(v) && v.length === 0) return false;
    return SUMMARY_PATTERNS.some((re) => re.test(k));
  });
}

function renderSummaryValue(value, indent = '') {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') return value.split('\n').map((l) => indent + l);
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      typeof item === 'object' && item !== null
        ? renderSummaryValue(item, `${indent}  `)
        : [`${indent}- ${item}`]
    );
  }
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [
      `${indent}${titleize(k)}:`,
      ...renderSummaryValue(v, `${indent}  `),
    ]);
  }
  return [`${indent}${value}`];
}

// ---------------------------------------------------------------------------
// Terminal dashboard
// ---------------------------------------------------------------------------

/** @param {ReturnType<typeof buildReport>} report */
export function renderDashboard(report, { barWidth = 30 } = {}) {
  const out = [];
  const m = report.meeting;

  out.push(heading(`Meeting Report - bot ${report.bot_id}`));
  out.push('');

  const overview = [];
  if (m?.meeting_link) overview.push(['Meeting', m.meeting_link]);
  if (m?.platform) overview.push(['Platform', m.platform]);
  if (m?.status) overview.push(['Final status', m.status]);
  if (m?.start_time) overview.push(['Started', timestamp(m.start_time)]);
  if (m?.end_time) overview.push(['Ended', timestamp(m.end_time)]);
  if (m?.duration !== null && m?.duration !== undefined) overview.push(['Duration (API)', String(m.duration)]);
  if (m?.transcript_id) overview.push(['Transcript id', m.transcript_id]);
  overview.push(['Participants', String(report.participants.count)]);
  if (report.participants.screenshares > 0) {
    overview.push(['Screen shares', String(report.participants.screenshares)]);
  }
  if (report.speech) {
    overview.push(['Speakers', String(report.speech.speakers.length)]);
    overview.push(['Speaking turns', String(report.speech.turn_count)]);
    overview.push([
      'Speech time',
      report.speech.speech_seconds !== null
        ? duration(report.speech.speech_seconds)
        : bytes(report.speech.speech_bytes),
    ]);
  }
  if (report.chat) overview.push(['Chat messages', String(report.chat.message_count)]);

  out.push(overview.length > 0 ? table(['Field', 'Value'], overview) : '(no session metadata available)');

  // --- Data availability -------------------------------------------------
  out.push(heading('Data sources'));
  out.push('');
  out.push(
    table(
      ['Endpoint', 'Result', 'Note'],
      Object.entries(report.sections).map(([key, status]) => [
        titleize(key),
        STATUS_LABEL[status] ?? status,
        report.section_notes?.[key] ? truncate(report.section_notes[key], 60) : '',
      ])
    )
  );

  // --- Summary -----------------------------------------------------------
  const highlights = summaryHighlights(report.summary);
  out.push(heading('AI summary'));
  out.push('');
  if (report.sections.summary !== 'ok') {
    out.push(`Not included - the AI summary is ${why(report.sections.summary)}.`);
    if (report.section_notes?.summary) out.push(report.section_notes.summary);
  } else if (highlights.length === 0) {
    out.push('The endpoint responded but contained no summary-shaped fields.');
    out.push('The full payload is in the JSON export under "raw.summary".');
  } else {
    for (const [key, value] of highlights) {
      out.push(titleize(key));
      out.push('-'.repeat(titleize(key).length));
      out.push(...renderSummaryValue(value));
      out.push('');
    }
  }

  // --- Talk time ---------------------------------------------------------
  out.push(heading('Talk-time share'));
  out.push('');
  if (!report.speech) {
    out.push(`Not included - the speaker timeline is ${why(report.sections.speaker_timeline)}.`);
  } else if (report.speech.speakers.length === 0) {
    out.push('No speech was attributed to any speaker.');
  } else {
    const hasSeconds = report.speech.speech_seconds !== null;
    for (const s of report.speech.speakers) {
      const label = truncate(s.name, 24).padEnd(24);
      const amount = hasSeconds ? duration(s.seconds) : bytes(s.bytes);
      out.push(`${label} ${bar(s.share, barWidth)} ${percent(s.share).padStart(6)}  ${amount}`);
    }
    out.push('');
    out.push(
      table(
        ['Speaker', 'Talk time', 'Share', 'Turns', 'Longest turn', 'Talked over'],
        report.speech.speakers.map((s) => [
          truncate(s.name, 24),
          hasSeconds ? duration(s.seconds) : bytes(s.bytes),
          percent(s.share),
          String(s.turns),
          hasSeconds ? duration(s.longestTurnSeconds) : bytes(s.longestTurnBytes),
          String(s.interruptions ?? 0),
        ]),
        { align: ['left', 'right', 'right', 'right', 'right', 'right'] }
      )
    );
    if (report.speech.longest_monologue) {
      const lm = report.speech.longest_monologue;
      out.push('');
      out.push(
        `Longest monologue: ${lm.speaker}, ${hasSeconds ? duration(lm.seconds) : bytes(lm.bytes)} ` +
          `across ${lm.chunks} chunk${lm.chunks === 1 ? '' : 's'}.`
      );
    }
    if (report.speech.silence_seconds !== null && report.speech.recording_seconds) {
      out.push(
        `Silence: ${duration(report.speech.silence_seconds)} of ${duration(report.speech.recording_seconds)} ` +
          `(${percent(report.speech.silence_seconds / report.speech.recording_seconds)}).`
      );
    }
  }

  // --- Participants ------------------------------------------------------
  out.push(heading('Participants'));
  out.push('');
  if (report.sections.participants !== 'ok') {
    out.push(`Not included - the participant roster is ${why(report.sections.participants)}.`);
  } else if (report.participants.roster.length === 0) {
    out.push('The roster came back empty.');
  } else {
    out.push(
      table(
        ['Participant', 'Status', 'Streams', 'Kind', 'Last seen'],
        report.participants.roster.map((p) => [
          truncate(p.name, 28),
          p.status ?? '-',
          String(p.stream_count),
          p.is_screenshare ? 'screen share' : 'person',
          p.last_updated ? timestamp(p.last_updated) : '-',
        ]),
        { align: ['left', 'left', 'right', 'left', 'left'] }
      )
    );
  }

  // --- Chat --------------------------------------------------------------
  out.push(heading('Chat'));
  out.push('');
  if (!report.chat) {
    out.push(`Not included - the chat log is ${why(report.sections.chats)}.`);
  } else if (report.chat.message_count === 0) {
    out.push('No chat messages were captured.');
  } else {
    out.push(`${report.chat.message_count} message${report.chat.message_count === 1 ? '' : 's'}.`);
    out.push('');
    out.push(
      table(
        ['Author', 'Messages'],
        report.chat.by_author.map((a) => [truncate(a.author, 28), String(a.count)]),
        { align: ['left', 'right'] }
      )
    );
  }

  // --- Lifecycle ---------------------------------------------------------
  if (report.lifecycle.length > 0) {
    out.push(heading('Lifecycle stages reached'));
    out.push('');
    for (const stage of report.lifecycle) {
      out.push(`  ${stage.timestamp ? timestamp(stage.timestamp) : '-'}  ${stage.stage}`);
    }
  }

  return out.join('\n');
}

function truncate(s, max) {
  const str = String(s ?? '');
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------

function mdEscape(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r/g, '');
}

function mdTable(headers, rows) {
  if (rows.length === 0) return '';
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(mdEscape).join(' | ')} |`),
  ].join('\n');
}

/** @param {ReturnType<typeof buildReport>} report */
export function renderMarkdown(report) {
  const lines = [];
  const m = report.meeting;

  lines.push(`# Meeting report`);
  lines.push('');
  lines.push(`Bot \`${report.bot_id}\` · generated ${timestamp(report.generated_at)}`);
  lines.push('');

  lines.push('## Overview');
  lines.push('');
  const overviewRows = [];
  if (m?.meeting_link) overviewRows.push(['Meeting', m.meeting_link]);
  if (m?.platform) overviewRows.push(['Platform', m.platform]);
  if (m?.status) overviewRows.push(['Final status', m.status]);
  if (m?.start_time) overviewRows.push(['Started', timestamp(m.start_time)]);
  if (m?.end_time) overviewRows.push(['Ended', timestamp(m.end_time)]);
  if (m?.transcript_id) overviewRows.push(['Transcript id', `\`${m.transcript_id}\``]);
  overviewRows.push(['Participants', String(report.participants.count)]);
  if (report.speech) {
    overviewRows.push(['Speakers', String(report.speech.speakers.length)]);
    overviewRows.push(['Speaking turns', String(report.speech.turn_count)]);
    if (report.speech.speech_seconds !== null) {
      overviewRows.push(['Speech time', duration(report.speech.speech_seconds)]);
    }
  }
  if (report.chat) overviewRows.push(['Chat messages', String(report.chat.message_count)]);
  lines.push(mdTable(['Field', 'Value'], overviewRows));
  lines.push('');

  lines.push('## Data sources');
  lines.push('');
  lines.push(
    mdTable(
      ['Endpoint', 'Result', 'Note'],
      Object.entries(report.sections).map(([key, status]) => [
        titleize(key),
        STATUS_LABEL[status] ?? status,
        report.section_notes?.[key] ?? '',
      ])
    )
  );
  lines.push('');

  lines.push('## AI summary');
  lines.push('');
  const highlights = summaryHighlights(report.summary);
  if (report.sections.summary !== 'ok') {
    lines.push(`_The AI summary is ${why(report.sections.summary)}._`);
  } else if (highlights.length === 0) {
    lines.push('_The endpoint responded but contained no summary-shaped fields._');
  } else {
    for (const [key, value] of highlights) {
      lines.push(`### ${titleize(key)}`);
      lines.push('');
      lines.push(renderSummaryValue(value).join('\n'));
      lines.push('');
    }
  }
  lines.push('');

  lines.push('## Talk time');
  lines.push('');
  if (!report.speech || report.speech.speakers.length === 0) {
    lines.push('_No speaker timeline available._');
  } else {
    const hasSeconds = report.speech.speech_seconds !== null;
    lines.push(
      mdTable(
        ['Speaker', 'Talk time', 'Share', 'Turns', 'Longest turn', 'Talked over'],
        report.speech.speakers.map((s) => [
          s.name,
          hasSeconds ? duration(s.seconds) : bytes(s.bytes),
          percent(s.share),
          String(s.turns),
          hasSeconds ? duration(s.longestTurnSeconds) : bytes(s.longestTurnBytes),
          String(s.interruptions ?? 0),
        ])
      )
    );
    lines.push('');
    if (report.speech.longest_monologue) {
      const lm = report.speech.longest_monologue;
      lines.push(
        `**Longest monologue:** ${lm.speaker}, ` +
          `${hasSeconds ? duration(lm.seconds) : bytes(lm.bytes)} across ${lm.chunks} chunks.`
      );
      lines.push('');
    }
    lines.push(
      '> Talk time is derived from byte offsets in the recorded audio file. Shares are exact; ' +
        'absolute durations assume 16-bit mono PCM.'
    );
    lines.push('');
  }

  lines.push('## Participants');
  lines.push('');
  if (report.participants.roster.length === 0) {
    lines.push('_No roster available._');
  } else {
    lines.push(
      mdTable(
        ['Participant', 'Status', 'Streams', 'Kind'],
        report.participants.roster.map((p) => [
          p.name,
          p.status ?? '-',
          String(p.stream_count),
          p.is_screenshare ? 'screen share' : 'person',
        ])
      )
    );
  }
  lines.push('');

  lines.push('## Chat');
  lines.push('');
  if (!report.chat || report.chat.message_count === 0) {
    lines.push('_No chat messages were captured._');
  } else {
    lines.push(
      mdTable(
        ['Author', 'Messages'],
        report.chat.by_author.map((a) => [a.author, String(a.count)])
      )
    );
    lines.push('');
    lines.push('### Transcript');
    lines.push('');
    for (const msg of report.chat.messages) {
      const when = msg.timestamp ? timestamp(msg.timestamp) : null;
      lines.push(`- **${mdEscape(msg.author || 'Unknown')}**${when ? ` · ${when}` : ''}: ${mdEscape(msg.text ?? '(no text)')}`);
    }
  }
  lines.push('');

  if (report.lifecycle.length > 0) {
    lines.push('## Lifecycle');
    lines.push('');
    lines.push(
      mdTable(
        ['Stage', 'Timestamp'],
        report.lifecycle.map((s) => [s.stage, s.timestamp ? timestamp(s.timestamp) : '-'])
      )
    );
    lines.push('');
  }

  return lines.join('\n');
}
