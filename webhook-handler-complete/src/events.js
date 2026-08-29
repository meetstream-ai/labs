/**
 * The complete MeetStream webhook event catalog.
 *
 * Envelope MeetStream POSTs to your `callback_url`:
 *
 *   {
 *     "event": "bot.inmeeting",     <-- the key is `event`, NOT `bot_event`
 *     "bot_id": "abc123",
 *     "bot_status": "InMeeting",
 *     "message": "Bot is in the meeting",
 *     "status_code": 200,
 *     "custom_attributes": { "any": "strings you passed to create_bot" }
 *   }
 *
 * Notes that trip people up:
 *   - `bot.stopped` is TERMINAL for the in-meeting phase and always carries
 *     status_code 200, even when the bot never got in. The reason lives in
 *     `bot_status`: Stopped | NotAllowed | Denied | Error.
 *   - `bot.error` is NOT terminal. It signals a streaming-provider problem
 *     while the bot keeps running.
 *   - status_code 500 only ever shows up on `transcription.failed` and on a
 *     failed `bot.done`.
 *   - Streaming-only transcription providers END the pipeline at
 *     `audio.processed`. They never emit `bot.done`.
 *   - `transcript_id` is NOT in any webhook. Take it from the create_bot
 *     response, `GET /bots/{id}/detail`, or `GET /bots/{id}/transcriptions`.
 */

/** Phase a given event belongs to. Useful for grouping in logs/dashboards. */
export const PHASE = {
  MEETING: 'meeting',
  PROCESSING: 'processing',
  RETENTION: 'retention',
};

/**
 * Every documented event, in the order MeetStream emits them.
 * `terminal` marks events after which no further events are expected
 * for that pipeline path.
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
    // Terminal for the meeting phase. Post-processing events may still follow
    // when the bot actually recorded something.
    terminal: true,
    summary: 'Bot is no longer in the meeting. `bot_status` says why.',
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
    // Terminal ONLY for streaming-only providers, which never emit bot.done.
    terminal: false,
    summary: 'Audio asset is ready. Terminal event for streaming-only bots.',
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
    summary:
      'Whole pipeline finished for post-call providers. status_code 500 means it finished unsuccessfully.',
  },
  data_deletion: {
    phase: PHASE.RETENTION,
    terminal: true,
    summary: 'Bot data was deleted (retention policy or DELETE /bots/{id}/delete).',
  },
};

/** All bot_status values `bot.stopped` can carry, with what each one means. */
export const STOPPED_REASONS = {
  Stopped: {
    ok: true,
    label: 'Clean stop',
    detail: 'The bot left normally. Expect post-processing events to follow.',
  },
  NotAllowed: {
    ok: false,
    label: 'Lobby timeout',
    detail:
      'Nobody admitted the bot before automatic_leave.waiting_room_timeout expired. No recording exists.',
  },
  Denied: {
    ok: false,
    label: 'Host denied entry',
    detail: 'A host explicitly rejected the bot at the lobby. No recording exists.',
  },
  Error: {
    ok: false,
    label: 'Bot error',
    detail:
      'The bot failed during the meeting. Read `message` for the cause. Recording may be partial or absent.',
  },
};

/**
 * Interpret status_code the way the API actually uses it.
 * Do NOT infer failure from `bot.stopped` having a non-200 code: it never does.
 */
export function interpretStatusCode(event, statusCode) {
  if (statusCode === 500) {
    if (event === 'transcription.failed') {
      return { ok: false, note: 'Transcription pipeline failed for this bot.' };
    }
    if (event === 'bot.done') {
      return { ok: false, note: 'Pipeline finished but the run was unsuccessful.' };
    }
    return { ok: false, note: 'Unexpected 500 on this event. Log and investigate.' };
  }
  if (statusCode === 200) {
    if (event === 'bot.stopped') {
      return {
        ok: true,
        note: 'Delivery is fine. Success/failure of the run is in bot_status, not this code.',
      };
    }
    return { ok: true, note: 'Normal delivery.' };
  }
  return { ok: statusCode < 400, note: `Uncommon status_code ${statusCode}.` };
}

/** True when this event ends the pipeline for the given transcription mode. */
export function isTerminalFor(event, { streamingOnly = false } = {}) {
  if (event === 'data_deletion') return true;
  if (streamingOnly) return event === 'audio.processed';
  return event === 'bot.done';
}

/** Normalize an incoming body into the fields we rely on. */
export function parseEnvelope(body) {
  if (!body || typeof body !== 'object') {
    return { valid: false, reason: 'Body is not a JSON object.' };
  }
  // Guard against the documentation error that says `bot_event`.
  const eventName = body.event ?? body.bot_event;
  if (!eventName) {
    return { valid: false, reason: 'Missing `event` key in envelope.' };
  }
  if (!body.event && body.bot_event) {
    return {
      valid: false,
      reason:
        'Envelope used `bot_event`. The real key is `event`. Refusing to guess.',
    };
  }
  if (!body.bot_id) {
    return { valid: false, reason: 'Missing `bot_id` in envelope.' };
  }
  return {
    valid: true,
    event: String(eventName),
    botId: String(body.bot_id),
    botStatus: body.bot_status ?? null,
    message: body.message ?? '',
    statusCode: typeof body.status_code === 'number' ? body.status_code : null,
    customAttributes: body.custom_attributes ?? {},
    known: Object.prototype.hasOwnProperty.call(EVENT_CATALOG, String(eventName)),
  };
}
