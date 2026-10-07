/**
 * Turns a MeetStream webhook payload into a lobby decision.
 *
 * A real delivery looks like this:
 *
 *   {
 *     "bot_id": "a29d00c3-...",
 *     "message": "Bot is waiting to be admitted",
 *     "event": "bot.in_waiting_room",
 *     "bot_event": "bot.in_waiting_room",
 *     "bot_status": "InWaitingRoom",
 *     "status_code": 200,
 *     "custom_attributes": { ... },
 *     "timestamp": "2026-08-09T07:16:44.675Z"
 *   }
 *
 * `event` is always present and is the generic name. `bot_event` is the
 * specific name: it equals `event` on every event except terminals.
 *
 * IMPORTANT: every ending arrives exactly once as `event: "bot.stopped"`, and
 * the REASON is in `bot_event`. Branch on that, not on `bot_status` or the
 * status code:
 *
 *   bot_event        status_code  bot_status               meaning
 *   bot.stopped      200          Stopped                  clean exit (meeting ended, API stop)
 *   bot.kicked       200          Stopped                  a participant removed the bot
 *   bot.notallowed   500          NotAllowed               never admitted before waiting_room_timeout
 *   bot.denied       500          Denied                   a host explicitly rejected the join request
 *   bot.failed       usually 500  FAILED / ERROR / Failed  unexpected failure in the bot lifecycle
 *
 * `bot_status` cannot tell a kick from a clean exit and its failure casing
 * varies, so it is only a case-insensitive fallback when `bot_event` is absent.
 * `bot.done` still follows every ending; this template acts on bot.stopped
 * because the lobby decision (retry or not) is already known at that point.
 */

export const LOBBY_OUTCOME = {
  STOPPED: 'Stopped',
  KICKED: 'Kicked',
  NOT_ALLOWED: 'NotAllowed',
  DENIED: 'Denied',
  ERROR: 'Error',
};

/** bot_event reason -> outcome. */
const REASON_TO_OUTCOME = {
  'bot.stopped': LOBBY_OUTCOME.STOPPED,
  'bot.kicked': LOBBY_OUTCOME.KICKED,
  'bot.notallowed': LOBBY_OUTCOME.NOT_ALLOWED,
  'bot.denied': LOBBY_OUTCOME.DENIED,
  'bot.failed': LOBBY_OUTCOME.ERROR,
};

/** Generic event name (`event` is always present). */
export function eventName(payload) {
  return payload?.event ?? payload?.bot_event ?? null;
}

/** Specific event name: on a terminal this is the stop reason. */
export function specificEventName(payload) {
  return payload?.bot_event ?? payload?.event ?? null;
}

export function botStatus(payload) {
  return payload?.bot_status ?? null;
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
 *   event: string|null,
 *   specific: string|null,
 *   status: string|null,
 *   botId: string|null,
 *   message: string|null,
 *   terminal: boolean,
 *   outcome: string|null,
 *   admitted: boolean,
 *   waiting: boolean,
 *   retryable: boolean,
 *   reason: string
 * }}
 */
export function classify(payload) {
  const event = eventName(payload);
  const specific = specificEventName(payload);
  const status = botStatus(payload);
  const botId = payload?.bot_id ?? null;
  const message = payload?.message ?? null;
  const statusLower = String(status ?? '').toLowerCase();

  const terminal = event === 'bot.stopped';
  const waiting = specific === 'bot.in_waiting_room' || statusLower === 'inwaitingroom';
  const admitted = specific === 'bot.inmeeting' || statusLower === 'inmeeting';

  let outcome = null;
  let retryable = false;
  let reason = '';

  if (terminal) {
    outcome = REASON_TO_OUTCOME[stopReason(payload)] ?? LOBBY_OUTCOME.ERROR;

    switch (outcome) {
      case LOBBY_OUTCOME.NOT_ALLOWED:
        // Nobody admitted it in time. A host may simply have been late - worth
        // another attempt with a longer wait.
        retryable = true;
        reason =
          'Lobby timeout: the bot waited but was never admitted before waiting_room_timeout elapsed.';
        break;
      case LOBBY_OUTCOME.DENIED:
        // A human said no. Retrying spams the host and will be denied again.
        retryable = false;
        reason = 'A host explicitly denied the bot\'s join request.';
        break;
      case LOBBY_OUTCOME.KICKED:
        // It got in, then a participant removed it. Sending it back would be rude.
        retryable = false;
        reason = 'A participant removed the bot from the meeting.';
        break;
      case LOBBY_OUTCOME.ERROR:
        retryable = false;
        reason = 'The bot failed with an unexpected error. Check the bot detail endpoint.';
        break;
      default:
        retryable = false;
        reason = 'The bot exited cleanly.';
    }
  }

  return { event, specific, status, botId, message, terminal, outcome, admitted, waiting, retryable, reason };
}
