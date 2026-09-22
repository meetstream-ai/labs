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
 * `event` is always present and is the generic name; `bot_event` is the
 * specific name and equals `event` on everything except terminals. Every
 * ending arrives exactly once as `event: "bot.stopped"`, with the reason in
 * `bot_event`:
 *
 *   bot_event        status_code  bot_status               meaning
 *   bot.stopped      200          Stopped                  clean exit
 *   bot.kicked       200          Stopped                  removed by a participant
 *   bot.notallowed   500          NotAllowed               never admitted from the waiting room
 *   bot.denied       500          Denied                   host refused entry or recording
 *   bot.failed       usually 500  FAILED / ERROR / Failed  crashed
 *
 * Branch on `bot_event`, not `bot_status`: a kick and a clean exit both say
 * "Stopped", and the failure casing varies. `bot_status` is only a
 * case-insensitive fallback when `bot_event` is missing. The earlier
 * `bot.recording_permission_denied` event is what tells a refused recording
 * prompt apart from a refused join.
 *
 * `bot.stopped` is not the end of the stream: post-call events follow and
 * `bot.done` is the final event on every path, streaming-only providers and
 * never-admitted bots included.
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

/** bot_event reason -> outcome label. */
const STOP_OUTCOMES = {
  'bot.stopped': 'Stopped',
  'bot.kicked': 'Kicked',
  'bot.notallowed': 'NotAllowed',
  'bot.denied': 'Denied',
  'bot.failed': 'Error',
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

/**
 * @returns {{
 *   event: string|null, specific: string|null, status: string|null,
 *   botId: string|null, message: string|null,
 *   phase: string|null, terminal: boolean, outcome: string|null,
 *   permission: 'allowed'|'denied'|null, note: string
 * }}
 */
export function classify(payload) {
  const event = eventName(payload);
  const specific = payload?.bot_event ?? event;
  const status = payload?.bot_status ?? null;
  const botId = payload?.bot_id ?? null;
  const message = payload?.message ?? null;

  let phase = null;
  let permission = null;
  let note = '';

  switch (specific) {
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
        'The bot now leaves - expect bot.leaving then bot.stopped (read the reason from bot_event).';
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

  // Every ending is exactly one `bot.stopped` delivery; the reason is in bot_event.
  const terminal = event === 'bot.stopped';
  let outcome = null;

  if (terminal) {
    phase = ZOOM_PHASE.FINISHED;
    outcome = STOP_OUTCOMES[stopReason(payload)] ?? 'Error';

    note =
      outcome === 'NotAllowed'
        ? 'Never admitted from the Zoom waiting room before waiting_room_timeout elapsed.'
        : outcome === 'Denied'
          ? 'A host refused the bot entry or recording. No recording was produced.'
          : outcome === 'Kicked'
            ? 'A participant removed the bot from the meeting.'
            : outcome === 'Error'
              ? 'Unexpected failure - inspect GET /bots/{id}/detail.'
              : 'Clean exit.';
    note += ' bot.done follows as the final event.';
  }

  return { event, specific, status, botId, message, phase, terminal, outcome, permission, note };
}

/**
 * Post-call artifact events, for logging completeness. audio.processed is
 * never final; bot.done is the last event on every path.
 */
export const POST_CALL_EVENTS = new Set([
  'manifest.completed',
  'audio.processed',
  'transcription.processed',
  'transcription.failed',
  'video.processed',
  'bot.done',
  'data_deletion',
]);
