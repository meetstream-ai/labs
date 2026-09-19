/**
 * The complete MeetStream webhook event catalog.
 *
 * Envelope MeetStream POSTs to your `callback_url`:
 *
 *   {
 *     "event": "bot.inmeeting",        <-- always present: the generic event name
 *     "bot_event": "bot.inmeeting",    <-- present on most events: the specific name
 *     "bot_id": "abc123",
 *     "bot_status": "InMeeting",
 *     "message": "Bot is in the meeting",
 *     "status_code": 200,
 *     "timestamp": "2026-06-18T17:02:11.514Z",
 *     "custom_attributes": { "any": "strings you passed to create_bot" }
 *   }
 *
 * Notes that trip people up:
 *   - `bot_event` equals `event` on every event EXCEPT terminals. A few events
 *     (manifest.completed, manifest.skipped, bot.transcriptionready,
 *     bot.uploading, participant_events.*) carry no `bot_event` at all, so read
 *     `bot_event ?? event` when you need the specific name.
 *   - Every ending arrives exactly once as `event: "bot.stopped"`. The REASON is
 *     in `bot_event`: bot.stopped | bot.kicked | bot.notallowed | bot.denied |
 *     bot.failed. `status_code` is 200 for a clean exit or a kick and 500 for
 *     notallowed, denied and most failures.
 *   - Do not branch on `bot_status` for the reason: a kick and a clean exit both
 *     say "Stopped", and failure casing varies (FAILED / ERROR / Failed). It is
 *     only a fallback, compared case-insensitively, when `bot_event` is missing.
 *   - `bot.error` is NOT terminal. It signals a streaming-provider problem
 *     while the bot keeps running.
 *   - `bot.done` is the FINAL event on EVERY path, streaming-only bots and
 *     never-admitted bots included. `audio.processed` is never final.
 *   - Streaming-only providers never send transcription.processed /
 *     transcription.failed: no post-call transcript exists for them.
 *   - Every event carries an ISO 8601 `timestamp`, lifecycle events included.
 *   - `transcript_id` is NOT in any webhook. Take it from the create_bot
 *     response, `GET /bots/{id}/detail`, or `GET /bots/{id}/transcriptions`.
 *   - participant_events.* use a nested shape: the bot id is at `data.bot.id`.
 */

/** Phase a given event belongs to. Useful for grouping in logs/dashboards. */
export const PHASE = {
  MEETING: 'meeting',
  PROCESSING: 'processing',
  RETENTION: 'retention',
};

/**
 * Every documented event, in the order MeetStream emits them, keyed by the
 * generic `event` name. `terminal` marks events after which no further events
 * are expected (other than a later data_deletion).
 */
export const EVENT_CATALOG = {
  'bot.joining': {
    phase: PHASE.MEETING,
    terminal: false,
    summary: 'Bot has been dispatched and is dialing into the meeting.',
  },
  'bot.in_waiting_room': {
    phase: PHASE.MEETING,
    terminal: false,
    summary: 'Bot is sitting in the lobby waiting for a host to admit it.',
  },
  'bot.inmeeting': {
    phase: PHASE.MEETING,
    terminal: false,
    summary: 'Bot was admitted and is now a participant.',
  },
  'bot.recording': {
    phase: PHASE.MEETING,
    terminal: false,
    summary: 'Recording has started.',
  },
  'bot.leaving': {
    phase: PHASE.MEETING,
    terminal: false,
    summary: 'Bot is on its way out of the meeting.',
  },
  'bot.stopped': {
    phase: PHASE.MEETING,
    // Ends the meeting phase only. Processing events and bot.done still follow.
    terminal: false,
    summary: 'Bot is no longer in the meeting. `bot_event` says why.',
  },
  'bot.error': {
    phase: PHASE.MEETING,
    terminal: false,
    summary: 'Non-terminal streaming-provider error. The bot keeps running.',
  },
  'manifest.completed': {
    phase: PHASE.PROCESSING,
    terminal: false,
    summary: 'Recording manifest sealed. Media assets are being produced.',
  },
  'audio.processed': {
    phase: PHASE.PROCESSING,
    terminal: false,
    summary: 'Audio asset is ready. Not final: bot.done still follows.',
  },
  'transcription.processed': {
    phase: PHASE.PROCESSING,
    terminal: false,
    summary: 'Post-call transcript is ready. Fetch it by transcript_id.',
  },
  'transcription.failed': {
    phase: PHASE.PROCESSING,
    terminal: false,
    summary: 'Transcription failed. Arrives with status_code 500.',
  },
  'video.processed': {
    phase: PHASE.PROCESSING,
    terminal: false,
    summary: 'Video asset is ready.',
  },
  'bot.done': {
    phase: PHASE.PROCESSING,
    terminal: true,
    summary: 'Final event on every path (post-call, streaming-only, never admitted).',
  },
  data_deletion: {
    phase: PHASE.RETENTION,
    terminal: true,
    summary: 'Bot data was deleted (retention policy or DELETE /bots/{id}/delete).',
  },
};

/**
 * Every reason a `bot.stopped` delivery can carry in `bot_event`, with what
 * each one means. `hasMedia` says whether processing events can follow.
 */
export const STOPPED_REASONS = {
  'bot.stopped': {
    ok: true,
    hasMedia: true,
    label: 'Clean exit',
    detail: 'Meeting ended, remove_bot, or a timeout. Expect processing events, then bot.done.',
  },
  'bot.kicked': {
    ok: true,
    hasMedia: true,
    label: 'Kicked by a participant',
    detail: 'Someone removed the bot from the call. What it recorded before that is still processed.',
  },
  'bot.notallowed': {
    ok: false,
    hasMedia: false,
    label: 'Lobby timeout',
    detail:
      'Nobody admitted the bot before automatic_leave.waiting_room_timeout expired. No recording exists.',
  },
  'bot.denied': {
    ok: false,
    hasMedia: false,
    label: 'Host denied entry',
    detail: 'A host refused entry or recording. No recording exists.',
  },
  'bot.failed': {
    ok: false,
    hasMedia: null, // may be partial or absent
    label: 'Bot failed',
    detail:
      'The bot crashed. Read `message` for the cause. Recording may be partial or absent.',
  },
};

/**
 * The reason a bot stopped, from a raw `bot.stopped` body.
 * Branch on `bot_event`. Only if it is missing, fall back to `bot_status`
 * compared case-insensitively (a kick cannot be told apart from a clean exit
 * on that path: both say "Stopped").
 */
export function stopReason(body) {
  if (body?.bot_event) return String(body.bot_event);
  const status = String(body?.bot_status ?? '').toLowerCase();
  if (status === 'notallowed') return 'bot.notallowed';
  if (status === 'denied') return 'bot.denied';
  if (status === 'error' || status === 'failed') return 'bot.failed';
  return 'bot.stopped';
}

/**
 * Interpret status_code the way the API actually uses it.
 * On `bot.stopped`, 500 is the normal code for notallowed / denied / most
 * failures, and 200 for a clean exit or a kick. It is a coarse hint; the
 * reason itself is in `bot_event`.
 */
export function interpretStatusCode(event, statusCode, reason = null) {
  if (event === 'bot.stopped') {
    const meta = STOPPED_REASONS[reason];
    return {
      ok: true,
      note: `Expected on bot.stopped (${reason ?? 'unknown reason'}: ${meta?.ok ? 'usually 200' : 'usually 500'}). Read bot_event, not this code.`,
    };
  }
  if (statusCode === 500) {
    if (event === 'transcription.failed') {
      return { ok: false, note: 'Transcription pipeline failed for this bot.' };
    }
    return { ok: false, note: 'Unexpected 500 on this event. Log and investigate.' };
  }
  if (statusCode === 200) return { ok: true, note: 'Normal delivery.' };
  return { ok: statusCode < 400, note: `Uncommon status_code ${statusCode}.` };
}

/**
 * True when this event ends the pipeline. `bot.done` is final on every path,
 * streaming-only included; `data_deletion` can arrive later still.
 */
export function isTerminal(event) {
  return event === 'bot.done' || event === 'data_deletion';
}

/** Normalize an incoming body into the fields we rely on. */
export function parseEnvelope(body) {
  if (!body || typeof body !== 'object') {
    return { valid: false, reason: 'Body is not a JSON object.' };
  }
  // `event` is always present and is the generic name. `bot_event` is the
  // specific name (it differs only on terminals) and is absent on a few events.
  const eventName = body.event ?? body.bot_event;
  if (!eventName) {
    return { valid: false, reason: 'Missing `event` key in envelope.' };
  }
  // participant_events.* nest the bot id under data.bot.id.
  const botId = body.bot_id ?? body.data?.bot?.id;
  if (!botId) {
    return { valid: false, reason: 'Missing `bot_id` in envelope.' };
  }
  const event = String(eventName);
  return {
    valid: true,
    event,
    botEvent: String(body.bot_event ?? event),
    reason: event === 'bot.stopped' ? stopReason(body) : null,
    botId: String(botId),
    botStatus: body.bot_status ?? null,
    message: body.message ?? '',
    statusCode: typeof body.status_code === 'number' ? body.status_code : null,
    timestamp: body.timestamp ?? null,
    customAttributes: body.custom_attributes ?? {},
    known: Object.prototype.hasOwnProperty.call(EVENT_CATALOG, event),
  };
}
