/**
 * Bot lifecycle interpretation for Microsoft Teams.
 *
 * Teams uses the same webhook lifecycle as every other platform - there is no
 * Teams-specific event. What differs is the timing (see README):
 *
 *   bot.joining -> bot.in_waiting_room -> bot.inmeeting -> bot.recording
 *     -> bot.leaving -> bot.stopped
 *     -> manifest.completed / audio.processed / transcription.processed /
 *        video.processed -> bot.done -> data_deletion
 *
 * `event` is always present and is the generic name; `bot_event` is the
 * specific name and equals `event` on everything except terminals:
 *
 *   { "bot_id": "...", "event": "bot.inmeeting", "bot_event": "bot.inmeeting",
 *     "bot_status": "InMeeting", "message": "...", "status_code": 200,
 *     "custom_attributes": {}, "timestamp": "..." }
 *
 * Every ending arrives exactly once as `event: "bot.stopped"`, with the reason
 * in `bot_event`. Branch on that, not on `bot_status`:
 *
 *   bot_event        status_code  bot_status
 *   bot.stopped      200          Stopped                  clean exit
 *   bot.kicked       200          Stopped                  removed by a participant
 *   bot.notallowed   500          NotAllowed               never admitted
 *   bot.denied       500          Denied                   admission rejected
 *   bot.failed       usually 500  FAILED / ERROR / Failed  crashed
 *
 * A kick and a clean exit share `bot_status: "Stopped"` and the failure casing
 * varies, so `bot_status` is only a case-insensitive fallback when `bot_event`
 * is missing. `bot.done` is the final event on every path, streaming-only
 * providers and never-admitted bots included.
 */

/** bot_event reason -> outcome label. */
export const STOP_OUTCOMES = {
  'bot.stopped': 'Stopped',
  'bot.kicked': 'Kicked',
  'bot.notallowed': 'NotAllowed',
  'bot.denied': 'Denied',
  'bot.failed': 'Error',
};

export const POST_CALL_EVENTS = new Set([
  'manifest.completed',
  'audio.processed',
  'transcription.processed',
  'transcription.failed',
  'video.processed',
  'bot.done',
  'data_deletion',
]);

const NOTES = {
  'bot.joining': 'MeetStream dispatched the bot.',
  'bot.in_waiting_room':
    'The bot is waiting for admission. On Teams this may be the meeting lobby, and it can be ' +
    'brief or long depending on the meeting\'s admission policy.',
  'bot.inmeeting':
    'In the meeting. On Teams recording normally starts on the first audio frame, typically ' +
    'within about a second - there is no host-permission gate like Zoom\'s.',
  'bot.recording': 'Capture started.',
  'bot.leaving': 'The bot is exiting. bot.stopped follows, with the reason in bot_event.',
  'manifest.completed': 'The recording manifest is ready.',
  'audio.processed': 'Audio processing finished. Not final: bot.done still follows.',
  'transcription.processed': 'Transcription finished - fetch it with the transcript_id.',
  'transcription.failed': 'Transcription failed.',
  'video.processed': 'Video processing finished.',
  'bot.done': 'Final event on every path: all requested post-call processing has finished.',
  'data_deletion': 'Stored media was deleted (manually, or after the retention window).',
};

export function eventName(payload) {
  return payload?.event ?? payload?.bot_event ?? null;
}

/**
 * The reason a bot stopped: `bot_event`, or when that is missing, `bot_status`
 * compared case-insensitively.
 */
export function stopReason(payload) {
  if (payload?.bot_event) return payload.bot_event;
  const status = String(payload?.bot_status ?? '').toLowerCase();
  if (status === 'notallowed') return 'bot.notallowed';
  if (status === 'denied') return 'bot.denied';
  if (status === 'error' || status === 'failed') return 'bot.failed';
  return 'bot.stopped';
}

export function classify(payload) {
  const event = eventName(payload);
  const specific = payload?.bot_event ?? event;
  const status = payload?.bot_status ?? null;
  const statusLower = String(status ?? '').toLowerCase();
  const botId = payload?.bot_id ?? null;
  const message = payload?.message ?? null;

  const terminal = event === 'bot.stopped';
  const postCall = POST_CALL_EVENTS.has(event);

  let outcome = null;
  let note = NOTES[event] ?? '';

  if (terminal) {
    outcome = STOP_OUTCOMES[stopReason(payload)] ?? 'Error';

    switch (outcome) {
      case 'NotAllowed':
        note =
          'The bot was not admitted before waiting_room_timeout elapsed. Someone with admission ' +
          'rights needs to let it in, or the meeting policy needs to allow it.';
        break;
      case 'Denied':
        note = 'Someone explicitly rejected the bot\'s request to join.';
        break;
      case 'Error':
        note = 'Unexpected failure - inspect GET /bots/{id}/detail.';
        break;
      case 'Kicked':
        note = 'A host or participant removed the bot from the meeting. What it recorded is still processed.';
        break;
      default:
        note = 'Clean exit. Post-call processing continues after this, ending with bot.done.';
    }
  }

  return {
    event,
    specific,
    status,
    botId,
    message,
    terminal,
    outcome,
    postCall,
    note,
    admitted: specific === 'bot.inmeeting' || statusLower === 'inmeeting',
    waiting: specific === 'bot.in_waiting_room' || statusLower === 'inwaitingroom',
    recording: specific === 'bot.recording' || statusLower === 'recording',
  };
}
