/**
 * Turn normalised chat messages into the two output formats.
 */

import { table, timestamp, heading } from './format.js';
import { authorCounts } from './normalize.js';

/**
 * The JSON export: normalised messages, the raw response, and a note about
 * how the normalisation was done so the file is self-describing.
 */
export function buildJson({ botId, raw, normalized, meetingMeta }) {
  return {
    bot_id: botId,
    exported_at: new Date().toISOString(),
    meeting: meetingMeta ?? null,
    message_count: normalized.total,
    normalization: {
      list_found_under: normalized.sourceKey,
      author_field: normalized.keysUsed.author,
      text_field: normalized.keysUsed.text,
      timestamp_field: normalized.keysUsed.timestamp,
      recipient_field: normalized.keysUsed.recipient,
      unmapped_fields: normalized.unmapped,
      note:
        'Field names were detected from the response, not assumed. Every message ' +
        'keeps its original object under "raw", and the untouched API response is ' +
        'included below as "raw_response".',
    },
    messages: normalized.messages.map((m) => ({
      index: m.index,
      author: m.author,
      text: m.text,
      timestamp: m.timestamp,
      recipient: m.recipient,
      raw: m.raw,
    })),
    raw_response: raw,
  };
}

function escapeMarkdown(text) {
  // Keep it readable: only neutralise things that would break the layout.
  return String(text).replace(/\r/g, '').replace(/\|/g, '\\|');
}

/** The Markdown export: a readable transcript of the chat. */
export function buildMarkdown({ botId, normalized, meetingMeta }) {
  const lines = [];
  lines.push('# Meeting chat log');
  lines.push('');
  lines.push(`- **Bot:** \`${botId}\``);
  if (meetingMeta?.MeetingLink) lines.push(`- **Meeting:** ${meetingMeta.MeetingLink}`);
  if (meetingMeta?.Platform) lines.push(`- **Platform:** ${meetingMeta.Platform}`);
  if (meetingMeta?.StartTime) lines.push(`- **Started:** ${timestamp(meetingMeta.StartTime)}`);
  if (meetingMeta?.EndTime) lines.push(`- **Ended:** ${timestamp(meetingMeta.EndTime)}`);
  lines.push(`- **Messages:** ${normalized.total}`);
  lines.push(`- **Exported:** ${timestamp(new Date().toISOString())}`);
  lines.push('');

  if (normalized.total === 0) {
    lines.push('> No chat messages were captured for this meeting.');
    lines.push('');
    return lines.join('\n');
  }

  const counts = authorCounts(normalized.messages);
  lines.push('## Who wrote what');
  lines.push('');
  lines.push('| Author | Messages |');
  lines.push('| --- | ---: |');
  for (const [author, count] of counts) {
    lines.push(`| ${escapeMarkdown(author)} | ${count} |`);
  }
  lines.push('');

  lines.push('## Transcript');
  lines.push('');
  for (const m of normalized.messages) {
    const when = m.timestamp ? timestamp(m.timestamp) : null;
    const who = m.author || 'Unknown';
    const head = when ? `**${escapeMarkdown(who)}** · ${when}` : `**${escapeMarkdown(who)}**`;
    const to = m.recipient ? ` · to ${escapeMarkdown(m.recipient)}` : '';
    lines.push(`### ${head}${to}`);
    lines.push('');
    if (m.text === null || m.text === '') {
      lines.push('_(no text content on this message - see the JSON export for the raw object)_');
    } else {
      for (const paragraph of String(m.text).split('\n')) {
        lines.push(paragraph.trim() === '' ? '' : escapeMarkdown(paragraph));
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** A compact console preview. */
export function renderPreview(normalized, { botId, limit = 20 }) {
  const out = [];
  out.push(heading(`Chat log - bot ${botId}`));
  out.push('');

  if (normalized.total === 0) {
    out.push('No chat messages were captured for this meeting.');
    out.push('');
    out.push('That is normal when nobody used the chat. If you expected messages:');
    out.push('  - confirm the bot was in the meeting for its whole duration');
    out.push('  - some platforms only expose chat sent after the bot joined');
    return out.join('\n');
  }

  const counts = authorCounts(normalized.messages);
  out.push(
    table(
      ['Author', 'Messages'],
      counts.map(([a, c]) => [a, String(c)]),
      { align: ['left', 'right'] }
    )
  );

  out.push(heading(normalized.total > limit ? `First ${limit} messages` : 'Messages'));
  out.push('');
  for (const m of normalized.messages.slice(0, limit)) {
    const when = m.timestamp ? timestamp(m.timestamp) : '-';
    const who = m.author || 'Unknown';
    const text = (m.text ?? '(no text field)').replace(/\s+/g, ' ').trim();
    out.push(`[${when}] ${who}: ${text.length > 120 ? `${text.slice(0, 119)}…` : text}`);
  }
  if (normalized.total > limit) {
    out.push('');
    out.push(`... and ${normalized.total - limit} more. Full log is in the exported files.`);
  }

  out.push(heading('Field mapping'));
  out.push('');
  out.push(`Message list found under: ${normalized.sourceKey ?? '(top-level array)'}`);
  out.push(`  author    -> ${normalized.keysUsed.author ?? 'not found'}`);
  out.push(`  text      -> ${normalized.keysUsed.text ?? 'not found'}`);
  out.push(`  timestamp -> ${normalized.keysUsed.timestamp ?? 'not found'}`);
  out.push(`  recipient -> ${normalized.keysUsed.recipient ?? 'not found'}`);
  if (normalized.unmapped.length > 0) {
    out.push(`  other fields present: ${normalized.unmapped.join(', ')}`);
  }
  if (!normalized.keysUsed.text) {
    out.push('');
    out.push('No text field was recognised. Add your account\'s key name to TEXT_KEYS');
    out.push('in src/normalize.js. The raw objects are preserved in the JSON export.');
  }

  return out.join('\n');
}
