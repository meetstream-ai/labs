/**
 * Render an attendance report for the terminal.
 */

import { duration, heading, percent, table, timestamp } from './format.js';

const NAME_WIDTH = 26;

function clip(name) {
  const s = String(name ?? 'Unknown');
  return s.length <= NAME_WIDTH ? s : `${s.slice(0, NAME_WIDTH - 1)}…`;
}

/**
 * @param {ReturnType<import('./tracker.js').AttendanceTracker['buildReport']>} report
 */
export function renderAttendance(report) {
  const out = [];

  out.push(heading(`Attendance - bot ${report.bot_id}`));
  out.push('');

  const meta = [
    ['Participants seen', String(report.participant_count)],
    ['Join / leave events', String(report.join_leave_events)],
  ];
  if (report.meeting_started_at) meta.push(['Meeting started', timestamp(report.meeting_started_at)]);
  if (report.meeting_ended_at) meta.push(['Meeting ended', timestamp(report.meeting_ended_at)]);
  if (report.meeting_seconds !== null) meta.push(['Meeting length', duration(report.meeting_seconds)]);
  out.push(table(['Metric', 'Value'], meta));

  if (report.participant_count === 0) {
    out.push('');
    out.push('No participants were recorded. Either the bot never joined, or no');
    out.push('participant_events reached the webhook. Check:');
    out.push('  - PUBLIC_URL is reachable from the internet (try the /health route)');
    out.push('  - realtime_endpoints was accepted on create_bot');
    out.push('  - GET /bots/{id}/status to see where the bot ended up');
    return out.join('\n');
  }

  out.push(heading('Who attended'));
  out.push('');
  out.push(
    table(
      ['Participant', 'Attended', 'Of meeting', 'Sessions', 'First join', 'Last leave', 'Note'],
      report.participants.map((p) => {
        const share =
          p.attended_seconds !== null && report.meeting_seconds
            ? percent(Math.min(1, p.attended_seconds / report.meeting_seconds))
            : '-';
        const notes = [];
        if (p.still_present) notes.push('never left');
        if (!p.attendance_exact && p.attended_seconds !== null) notes.push('estimated');
        if (p.session_count === 0) notes.push('roster only');
        // humanized_status is a readable label; the bare numeric `status`
        // code is not, so only surface the readable form.
        if (p.roster_status && !/^\d+$/.test(String(p.roster_status))) notes.push(p.roster_status);
        return [
          clip(p.name),
          p.attended_seconds !== null ? duration(p.attended_seconds) : '-',
          share,
          String(p.session_count),
          p.first_join ? timestamp(p.first_join) : '-',
          p.last_leave ? timestamp(p.last_leave) : '-',
          notes.join(', ') || '',
        ];
      }),
      { align: ['left', 'right', 'right', 'right', 'left', 'left', 'left'] }
    )
  );

  const rejoiners = report.participants.filter((p) => p.session_count > 1);
  if (rejoiners.length > 0) {
    out.push(heading('Rejoined during the call'));
    out.push('');
    for (const p of rejoiners) {
      out.push(`${p.name} - ${p.session_count} separate sessions:`);
      for (const s of p.sessions) {
        out.push(`  ${timestamp(s.joinedAt) ?? '(before tracking started)'} → ${timestamp(s.leftAt) ?? '(still present)'}`);
      }
    }
  }

  const estimated = report.participants.filter((p) => !p.attendance_exact && p.attended_seconds !== null);
  if (estimated.length > 0) {
    out.push(heading('Note on estimated figures'));
    out.push('');
    out.push('Some participants were missing a join or leave event, so their attended');
    out.push('time is bounded by the meeting start/end instead. Those rows are marked');
    out.push('"estimated". A participant present before the bot joined has no join event');
    out.push('by definition.');
  }

  if (report.bot_lifecycle.length > 0) {
    out.push(heading('Bot lifecycle'));
    out.push('');
    for (const e of report.bot_lifecycle) {
      out.push(`  ${timestamp(e.at)}  ${e.event}${e.status ? ` (${e.status})` : ''}`);
    }
  }

  return out.join('\n');
}
