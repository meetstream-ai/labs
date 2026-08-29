/**
 * Turns a MeetStream webhook payload into a lobby decision.
 *
 * A real delivery looks like this (captured from the docs' signing example):
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
 * Payloads carry the event name under `event`, with `bot_event` as an alias.
 * We read `event` first and fall back to `bot_event`.
 *
 * IMPORTANT: branch on `bot_status`, not on the event name or the status code.
 * Depending on how a terminal outcome is reported you may see either
 * `bot.stopped` carrying a `bot_status` that says why, or the more specific
 * `bot.notallowed` / `bot.denied` / `bot.kicked` / `bot.failed` events. The
 * `bot_status` value is the same in both shapes:
 *
 *   Stopped     clean exit (meeting ended, API stop, host ended the call)
 *   NotAllowed  never admitted before waiting_room_timeout elapsed
 *   Denied      a host explicitly rejected the join request
 *   Error       unexpected failure in the bot lifecycle
 */

export const LOBBY_OUTCOME = {
  STOPPED: 'Stopped',
  NOT_ALLOWED: 'NotAllowed',
  DENIED: 'Denied',
  ERROR: 'Error',
};

const TERMINAL_EVENTS = new Set([
  'bot.stopped',
  'bot.notallowed',
  'bot.denied',
  'bot.kicked',
  'bot.failed',
]);

const TERMINAL_STATUSES = new Set([
  LOBBY_OUTCOME.STOPPED,
  LOBBY_OUTCOME.NOT_ALLOWED,
  LOBBY_OUTCOME.DENIED,
  LOBBY_OUTCOME.ERROR,
]);

/** Event name, tolerant of either envelope key. */
export function eventName(payload) {
  return payload?.event ?? payload?.bot_event ?? null;
}

export function botStatus(payload) {
  return payload?.bot_status ?? null;
}

/**
 * @returns {{
 *   event: string|null,
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
  const status = botStatus(payload);
  const botId = payload?.bot_id ?? null;
  const message = payload?.message ?? null;

  const terminal = TERMINAL_STATUSES.has(status) || TERMINAL_EVENTS.has(event);
  const waiting = event === 'bot.in_waiting_room' || status === 'InWaitingRoom';
  const admitted = event === 'bot.inmeeting' || status === 'InMeeting';

  let outcome = null;
  let retryable = false;
  let reason = '';

  if (terminal) {
    outcome = TERMINAL_STATUSES.has(status)
      ? status
      : event === 'bot.notallowed'
        ? LOBBY_OUTCOME.NOT_ALLOWED
        : event === 'bot.denied'
          ? LOBBY_OUTCOME.DENIED
          : event === 'bot.failed'
            ? LOBBY_OUTCOME.ERROR
            : LOBBY_OUTCOME.STOPPED;

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
      case LOBBY_OUTCOME.ERROR:
        retryable = false;
        reason = 'The bot failed with an unexpected error. Check the bot detail endpoint.';
        break;
      default:
        retryable = false;
        reason = 'The bot exited cleanly.';
    }
  }

  return { event, status, botId, message, terminal, outcome, admitted, waiting, retryable, reason };
}
