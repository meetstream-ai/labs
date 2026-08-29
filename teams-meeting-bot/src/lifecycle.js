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
 * Payloads carry the event name under `event`, with `bot_event` as an alias:
 *
 *   { "bot_id": "...", "event": "bot.inmeeting", "bot_event": "bot.inmeeting",
 *     "bot_status": "InMeeting", "message": "...", "status_code": 200,
 *     "custom_attributes": {}, "timestamp": "..." }
 *
 * Branch on `bot_status`. A terminal result may arrive either as `bot.stopped`
 * carrying a status that explains why, or as the more specific
 * `bot.notallowed` / `bot.denied` / `bot.kicked` / `bot.failed` event -
 * `bot_status` is the same value in both shapes.
 */

export const TERMINAL_STATUSES = new Set(['Stopped', 'NotAllowed', 'Denied', 'Error']);

export const TERMINAL_EVENTS = new Set([
  'bot.stopped',
  'bot.notallowed',
  'bot.denied',
  'bot.kicked',
  'bot.failed',
]);

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
  'bot.leaving': 'The bot is exiting. A terminal event follows.',
  'manifest.completed': 'The recording manifest is ready.',
  'audio.processed': 'Audio processing finished.',
  'transcription.processed': 'Transcription finished - fetch it with the transcript_id.',
  'transcription.failed': 'Transcription failed.',
  'video.processed': 'Video processing finished.',
  'bot.done': 'All requested post-call processing has finished.',
  'data_deletion': 'Stored media was deleted (manually, or after the retention window).',
};

export function eventName(payload) {
  return payload?.event ?? payload?.bot_event ?? null;
}

export function classify(payload) {
  const event = eventName(payload);
  const status = payload?.bot_status ?? null;
  const botId = payload?.bot_id ?? null;
  const message = payload?.message ?? null;

  const terminal = TERMINAL_STATUSES.has(status) || TERMINAL_EVENTS.has(event);
  const postCall = POST_CALL_EVENTS.has(event);

  let outcome = null;
  let note = NOTES[event] ?? '';

  if (terminal) {
    outcome = TERMINAL_STATUSES.has(status)
      ? status
      : event === 'bot.notallowed'
        ? 'NotAllowed'
        : event === 'bot.denied'
          ? 'Denied'
          : event === 'bot.failed'
            ? 'Error'
            : 'Stopped';

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
      default:
        note =
          event === 'bot.kicked'
            ? 'A host or participant removed the bot from the meeting.'
            : 'Clean exit. Post-call processing continues after this.';
    }
  }

  return {
    event,
    status,
    botId,
    message,
    terminal,
    outcome,
    postCall,
    note,
    admitted: event === 'bot.inmeeting' || status === 'InMeeting',
    waiting: event === 'bot.in_waiting_room' || status === 'InWaitingRoom',
    recording: event === 'bot.recording' || status === 'Recording',
  };
}
