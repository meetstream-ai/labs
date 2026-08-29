/**
 * The MeetStream bot lifecycle, as an explicit state machine.
 *
 * Why bother instead of just switching on the event name:
 *
 *   - Webhook delivery is at-least-once and NOT order-guaranteed. A naive
 *     handler that assigns `state = eventName` will happily walk backwards
 *     when a delayed `bot.joining` lands after `bot.recording`.
 *   - Where the lifecycle ENDS depends on the transcription provider. Post-call
 *     providers finish at `bot.done`. Streaming-only providers finish at
 *     `audio.processed` and never emit `bot.done` at all.
 *   - `bot.stopped` is terminal for the meeting but carries FOUR different
 *     outcomes in `bot_status`, two of which mean no media will ever exist.
 *   - `bot.error` is not terminal and must not move the machine.
 *
 * Every state carries a `rank`. The machine only ever moves forward in rank,
 * so a late or duplicated event is recorded and ignored rather than
 * corrupting the record.
 */

export const STATES = {
  created: { rank: 0, terminal: false, label: 'Created, no webhooks yet' },
  joining: { rank: 1, terminal: false, label: 'Dialing into the meeting' },
  waiting_room: { rank: 2, terminal: false, label: 'In the lobby, awaiting admission' },
  in_meeting: { rank: 3, terminal: false, label: 'Admitted as a participant' },
  recording: { rank: 4, terminal: false, label: 'Recording' },
  leaving: { rank: 5, terminal: false, label: 'Leaving the meeting' },

  // bot.stopped outcomes
  stopped: { rank: 6, terminal: false, label: 'Left cleanly, awaiting processing' },
  stopped_error: {
    rank: 6,
    terminal: false,
    label: 'Stopped after an in-meeting error, partial assets may still arrive',
  },
  not_allowed: {
    rank: 6,
    terminal: true,
    outcome: 'failure',
    label: 'Never admitted (lobby timeout). No media exists.',
  },
  denied: {
    rank: 6,
    terminal: true,
    outcome: 'failure',
    label: 'Host denied entry. No media exists.',
  },

  // post-processing
  processing: { rank: 7, terminal: false, label: 'Manifest sealed, producing assets' },
  media_ready: { rank: 8, terminal: false, label: 'Audio ready, still finishing' },
  transcribed: { rank: 9, terminal: false, label: 'Transcript ready, still finishing' },

  // terminals
  done: { rank: 10, terminal: true, outcome: 'success', label: 'Pipeline complete' },
  done_failed: {
    rank: 10,
    terminal: true,
    outcome: 'failure',
    label: 'Pipeline finished unsuccessfully (bot.done with status_code 500)',
  },
  completed_streaming: {
    rank: 10,
    terminal: true,
    outcome: 'success',
    label: 'Complete: streaming-only bots end at audio.processed and never emit bot.done',
  },
  deleted: { rank: 11, terminal: true, outcome: 'deleted', label: 'Bot data deleted' },
};

/**
 * How long a bot may sit in a state before it counts as stuck.
 * Tune these to your own `automatic_leave` settings and meeting lengths.
 */
export const STATE_TIMEOUTS_MS = {
  created: 5 * 60 * 1000, // bot created but zero webhooks: usually a bad callback_url
  joining: 5 * 60 * 1000,
  // Should be bounded by automatic_leave.waiting_room_timeout, plus slack.
  waiting_room: 10 * 60 * 1000,
  in_meeting: 6 * 60 * 60 * 1000,
  recording: 6 * 60 * 60 * 1000,
  leaving: 10 * 60 * 1000,
  stopped: 45 * 60 * 1000, // manifest.completed should follow reasonably fast
  stopped_error: 45 * 60 * 1000,
  processing: 2 * 60 * 60 * 1000,
  media_ready: 2 * 60 * 60 * 1000,
  transcribed: 2 * 60 * 60 * 1000,
};

/** Terminal states, by what they mean for you. */
export const TERMINAL_STATES = Object.entries(STATES)
  .filter(([, meta]) => meta.terminal)
  .map(([name]) => name);

/**
 * Resolve an event into a target state.
 * Returns null when the event carries information but should not move state.
 */
export function targetStateFor(event, { botStatus, statusCode, streamingOnly }) {
  switch (event) {
    case 'bot.joining':
      return 'joining';
    case 'bot.in_waiting_room':
      return 'waiting_room';
    case 'bot.inmeeting':
      return 'in_meeting';
    case 'bot.recording':
      return 'recording';
    case 'bot.leaving':
      return 'leaving';

    case 'bot.stopped':
      // status_code is 200 here no matter what happened. The outcome is in
      // bot_status, and there are exactly four values.
      switch (botStatus) {
        case 'Stopped':
          return 'stopped';
        case 'NotAllowed':
          return 'not_allowed';
        case 'Denied':
          return 'denied';
        case 'Error':
          return 'stopped_error';
        default:
          return 'stopped_error';
      }

    // Non-terminal streaming-provider error. The bot is still running, so the
    // machine must NOT move.
    case 'bot.error':
      return null;

    case 'manifest.completed':
      return 'processing';

    case 'audio.processed':
      // The fork in the road. Streaming-only providers stop here.
      return streamingOnly ? 'completed_streaming' : 'media_ready';

    case 'transcription.processed':
      return 'transcribed';

    // Arrives with status_code 500. Records a failure but does not end the run:
    // video.processed and bot.done can still follow.
    case 'transcription.failed':
      return null;

    case 'video.processed':
      return null;

    case 'bot.done':
      return statusCode === 500 ? 'done_failed' : 'done';

    case 'data_deletion':
      return 'deleted';

    default:
      return null;
  }
}

/**
 * Apply one webhook event to a bot record. Mutates and returns `record`.
 *
 * @param {object} record  from store.js
 * @param {object} envelope  { event, botId, botStatus, statusCode, message }
 * @returns {{ moved: boolean, from: string, to: string, note: string }}
 */
export function applyEvent(record, envelope) {
  const now = new Date().toISOString();
  const { event, botStatus, statusCode, message } = envelope;

  record.lastEventAt = now;
  record.history.push({ at: now, event, botStatus, statusCode });

  // Side facts that are worth recording regardless of state movement.
  if (event === 'bot.error') {
    record.nonTerminalErrors.push({ at: now, message });
  }
  if (event === 'transcription.failed') {
    record.assets.transcript = 'failed';
    record.failures.push({ at: now, kind: 'transcription', message, statusCode });
  }
  if (event === 'transcription.processed') record.assets.transcript = 'ready';
  if (event === 'audio.processed') record.assets.audio = 'ready';
  if (event === 'video.processed') record.assets.video = 'ready';
  if (event === 'bot.stopped') {
    record.stopReason = botStatus;
    record.stopMessage = message;
  }
  if (event === 'bot.done' && statusCode === 500) {
    record.failures.push({ at: now, kind: 'pipeline', message, statusCode });
  }

  const from = record.state;
  const to = targetStateFor(event, { botStatus, statusCode, streamingOnly: record.streamingOnly });

  if (to === null) {
    return { moved: false, from, to: from, note: `${event} recorded, no state change` };
  }
  if (!STATES[to]) {
    return { moved: false, from, to: from, note: `unknown target state "${to}", ignored` };
  }
  if (STATES[from].terminal) {
    // `deleted` is the one thing that may follow a terminal state.
    if (to === 'deleted') {
      record.state = 'deleted';
      record.enteredStateAt = now;
      record.finishedAt = now;
      return { moved: true, from, to, note: 'data_deletion after a terminal state' };
    }
    return {
      moved: false,
      from,
      to,
      note: `already terminal in "${from}", ignoring ${event}`,
    };
  }
  if (STATES[to].rank < STATES[from].rank) {
    // Out-of-order or duplicate delivery. Never walk backwards.
    return {
      moved: false,
      from,
      to,
      note: `out-of-order ${event}: "${to}" ranks below current "${from}", ignored`,
    };
  }
  if (to === from) {
    return { moved: false, from, to, note: `duplicate ${event}, already in "${from}"` };
  }

  record.state = to;
  record.enteredStateAt = now;
  if (STATES[to].terminal) {
    record.finishedAt = now;
    record.outcome = STATES[to].outcome;
  }
  return { moved: true, from, to, note: STATES[to].label };
}

/** Human-readable outcome for a finished bot, or null while it is still running. */
export function summarizeOutcome(record) {
  const meta = STATES[record.state];
  if (!meta.terminal) return null;
  return {
    state: record.state,
    outcome: meta.outcome,
    label: meta.label,
    stopReason: record.stopReason ?? null,
    assets: record.assets,
    failures: record.failures,
    nonTerminalErrors: record.nonTerminalErrors.length,
    durationMs: record.finishedAt
      ? new Date(record.finishedAt) - new Date(record.createdAt)
      : null,
  };
}
