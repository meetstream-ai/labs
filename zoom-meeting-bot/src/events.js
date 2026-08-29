/**
 * Zoom lifecycle interpretation.
 *
 * Zoom is the only platform where recording is gated on host consent, so its
 * lifecycle has two extra events that Google Meet and Teams never emit:
 *
 *   bot.recording_permission_allowed   bot_status "RecordingPermissionAllowed"
 *   bot.recording_permission_denied    bot_status "RecordingPermissionDenied"
 *
 * The happy path:
 *   bot.joining -> bot.in_waiting_room -> bot.inmeeting
 *     -> bot.recording_permission_allowed -> bot.recording -> ... -> bot.stopped
 *
 * The denied path (host says no, or never answers within
 * recording_permission_denied_timeout):
 *   ... -> bot.inmeeting -> bot.recording_permission_denied
 *     -> bot.leaving -> bot.stopped
 *
 * Note that a permission denial ends in a *clean* stop. It is not `bot.denied`,
 * which means a host rejected the bot's request to join the meeting at all.
 *
 * Webhook payloads carry the event name under `event`, with `bot_event` as an
 * alias. Branch on `bot_status` where you can - it is consistent whether a
 * terminal outcome arrives as `bot.stopped` with a status, or as the more
 * specific `bot.notallowed` / `bot.denied` / `bot.failed` event.
 */

export const ZOOM_PHASE = {
  JOINING: 'joining',
  WAITING_ROOM: 'waiting_room',
  IN_MEETING: 'in_meeting',
  AWAITING_PERMISSION: 'awaiting_recording_permission',
  RECORDING: 'recording',
  LEAVING: 'leaving',
  FINISHED: 'finished',
};

const TERMINAL_STATUSES = new Set(['Stopped', 'NotAllowed', 'Denied', 'Error']);
const TERMINAL_EVENTS = new Set([
  'bot.stopped',
  'bot.notallowed',
  'bot.denied',
  'bot.kicked',
  'bot.failed',
]);

export function eventName(payload) {
  return payload?.event ?? payload?.bot_event ?? null;
}

/**
 * @returns {{
 *   event: string|null, status: string|null, botId: string|null, message: string|null,
 *   phase: string|null, terminal: boolean, outcome: string|null,
 *   permission: 'allowed'|'denied'|null, note: string
 * }}
 */
export function classify(payload) {
  const event = eventName(payload);
  const status = payload?.bot_status ?? null;
  const botId = payload?.bot_id ?? null;
  const message = payload?.message ?? null;

  let phase = null;
  let permission = null;
  let note = '';

  switch (event) {
    case 'bot.joining':
      phase = ZOOM_PHASE.JOINING;
      break;
    case 'bot.in_waiting_room':
      phase = ZOOM_PHASE.WAITING_ROOM;
      note = 'Zoom waiting room. The host has to admit the bot before anything else happens.';
      break;
    case 'bot.inmeeting':
      phase = ZOOM_PHASE.AWAITING_PERMISSION;
      note =
        'In the meeting. On Zoom the bot now asks the host for recording permission, so expect a ' +
        'gap before bot.recording. On Meet and Teams recording starts within about a second.';
      break;
    case 'bot.recording_permission_allowed':
      phase = ZOOM_PHASE.AWAITING_PERMISSION;
      permission = 'allowed';
      note = 'Host granted recording permission.';
      break;
    case 'bot.recording_permission_denied':
      phase = ZOOM_PHASE.LEAVING;
      permission = 'denied';
      note =
        'Host denied recording, or did not answer within recording_permission_denied_timeout. ' +
        'The bot now leaves cleanly - expect bot.leaving then bot.stopped.';
      break;
    case 'bot.recording':
      phase = ZOOM_PHASE.RECORDING;
      note = 'Recording started.';
      break;
    case 'bot.leaving':
      phase = ZOOM_PHASE.LEAVING;
      break;
    default:
      phase = null;
  }

  if (status === 'RecordingPermissionAllowed') permission = 'allowed';
  if (status === 'RecordingPermissionDenied') permission = 'denied';

  const terminal = TERMINAL_STATUSES.has(status) || TERMINAL_EVENTS.has(event);
  let outcome = null;

  if (terminal) {
    phase = ZOOM_PHASE.FINISHED;
    outcome = TERMINAL_STATUSES.has(status)
      ? status
      : event === 'bot.notallowed'
        ? 'NotAllowed'
        : event === 'bot.denied'
          ? 'Denied'
          : event === 'bot.failed'
            ? 'Error'
            : 'Stopped';

    if (!note) {
      note =
        outcome === 'NotAllowed'
          ? 'Never admitted from the Zoom waiting room before waiting_room_timeout elapsed.'
          : outcome === 'Denied'
            ? 'A host rejected the bot\'s request to join the meeting.'
            : outcome === 'Error'
              ? 'Unexpected failure - inspect GET /bots/{id}/detail.'
              : 'Clean exit.';
    }
  }

  return { event, status, botId, message, phase, terminal, outcome, permission, note };
}

/** Post-call artifact events, for logging completeness. */
export const POST_CALL_EVENTS = new Set([
  'manifest.completed',
  'audio.processed',
  'transcription.processed',
  'transcription.failed',
  'video.processed',
  'bot.done',
  'data_deletion',
]);
