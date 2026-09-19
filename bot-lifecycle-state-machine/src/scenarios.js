/**
 * Synthetic webhook sequences for exercising the machine offline.
 *
 * Shaped exactly like real deliveries. Nothing here calls the API:
 *   - `event` always present; `bot_event` equals it except on terminals and is
 *     absent on manifest.completed
 *   - every ending is `event: "bot.stopped"` with the reason in `bot_event`
 *   - every delivery carries an ISO 8601 `timestamp`
 *   - every path ends with `bot.done`
 */

/** Monotonic fake clock so each envelope gets a distinct, ordered timestamp. */
let clock = Date.parse('2026-06-18T17:00:00.000Z');
const nextTimestamp = () => new Date((clock += 1500)).toISOString();

/** Events that never carry `bot_event` in production. */
const NO_BOT_EVENT = new Set(['manifest.completed']);

const ev = (event, botId, extra = {}) => {
  const envelope = {
    event,
    bot_id: botId,
    bot_status: extra.bot_status ?? null,
    message: extra.message ?? '',
    status_code: extra.status_code ?? 200,
    timestamp: nextTimestamp(),
    custom_attributes: {
      streaming_only: String(Boolean(extra.streamingOnly)),
      ...(extra.custom_attributes ?? {}),
    },
  };
  if (!NO_BOT_EVENT.has(event)) envelope.bot_event = extra.bot_event ?? event;
  return envelope;
};

/** A terminal: always `event: "bot.stopped"`, reason in `bot_event`. */
const stop = (reason, botId, extra = {}) => ev('bot.stopped', botId, { ...extra, bot_event: reason });

/** Post-call provider. Ends at bot.done. */
export function postCallPath(botId = 'lc-postcall') {
  const o = { streamingOnly: false };
  return [
    ev('bot.joining', botId, { ...o, bot_status: 'Joining' }),
    ev('bot.in_waiting_room', botId, { ...o, bot_status: 'InWaitingRoom' }),
    ev('bot.inmeeting', botId, { ...o, bot_status: 'InMeeting' }),
    ev('bot.recording', botId, { ...o, bot_status: 'Recording' }),
    ev('bot.leaving', botId, { ...o, bot_status: 'Leaving' }),
    stop('bot.stopped', botId, { ...o, bot_status: 'Stopped', message: 'Left cleanly' }),
    ev('manifest.completed', botId, o),
    ev('audio.processed', botId, o),
    ev('transcription.processed', botId, o),
    ev('video.processed', botId, o),
    ev('bot.done', botId, o),
  ];
}

/** Streaming-only provider. No transcription events, but still ends at bot.done. */
export function streamingOnlyPath(botId = 'lc-streaming') {
  const o = { streamingOnly: true };
  return [
    ev('bot.joining', botId, { ...o, bot_status: 'Joining' }),
    ev('bot.inmeeting', botId, { ...o, bot_status: 'InMeeting' }),
    ev('bot.recording', botId, { ...o, bot_status: 'Recording' }),
    // Non-terminal: the machine must not move for this.
    ev('bot.error', botId, { ...o, message: 'streaming socket reconnected' }),
    ev('bot.leaving', botId, { ...o, bot_status: 'Leaving' }),
    stop('bot.stopped', botId, { ...o, bot_status: 'Stopped' }),
    ev('manifest.completed', botId, o),
    ev('audio.processed', botId, o),
    ev('bot.done', botId, o),
  ];
}

/** A participant removed the bot. bot_status says "Stopped"; bot_event says kicked. */
export function kickedPath(botId = 'lc-kicked') {
  const o = { streamingOnly: false };
  return [
    ev('bot.joining', botId, { ...o, bot_status: 'Joining' }),
    ev('bot.inmeeting', botId, { ...o, bot_status: 'InMeeting' }),
    ev('bot.recording', botId, { ...o, bot_status: 'Recording' }),
    ev('bot.leaving', botId, { ...o, bot_status: 'Leaving' }),
    stop('bot.kicked', botId, { ...o, bot_status: 'Stopped', message: 'Removed by a participant' }),
    ev('manifest.completed', botId, o),
    ev('audio.processed', botId, o),
    ev('transcription.processed', botId, o),
    ev('bot.done', botId, o),
  ];
}

/** Lobby timeout. bot.stopped with bot_event bot.notallowed and status_code 500, then bot.done. */
export function notAllowedPath(botId = 'lc-notallowed') {
  const o = { streamingOnly: false };
  return [
    ev('bot.joining', botId, { ...o, bot_status: 'Joining' }),
    ev('bot.in_waiting_room', botId, { ...o, bot_status: 'InWaitingRoom' }),
    ev('bot.leaving', botId, { ...o, bot_status: 'Leaving' }),
    stop('bot.notallowed', botId, {
      ...o,
      bot_status: 'NotAllowed',
      message: 'Waiting room timeout',
      status_code: 500,
    }),
    ev('bot.done', botId, o),
  ];
}

/** Host denied entry: bot_event bot.denied, status_code 500, then bot.done. */
export function deniedPath(botId = 'lc-denied') {
  const o = { streamingOnly: false };
  return [
    ev('bot.joining', botId, { ...o, bot_status: 'Joining' }),
    ev('bot.in_waiting_room', botId, { ...o, bot_status: 'InWaitingRoom' }),
    ev('bot.leaving', botId, { ...o, bot_status: 'Leaving' }),
    stop('bot.denied', botId, { ...o, bot_status: 'Denied', message: 'Host denied the bot', status_code: 500 }),
    ev('bot.done', botId, o),
  ];
}

/** Bot crashed in-meeting (bot.failed, 500), transcription failed (500), then bot.done. */
export function failurePath(botId = 'lc-failed') {
  const o = { streamingOnly: false };
  return [
    ev('bot.joining', botId, { ...o, bot_status: 'Joining' }),
    ev('bot.inmeeting', botId, { ...o, bot_status: 'InMeeting' }),
    ev('bot.recording', botId, { ...o, bot_status: 'Recording' }),
    // bot_status casing varies (FAILED / ERROR / Failed); bot_event does not.
    stop('bot.failed', botId, { ...o, bot_status: 'ERROR', message: 'Bot crashed mid-meeting', status_code: 500 }),
    ev('manifest.completed', botId, o),
    ev('audio.processed', botId, o),
    ev('transcription.failed', botId, { ...o, message: 'ASR provider error', status_code: 500 }),
    ev('bot.done', botId, o),
  ];
}

/**
 * Deliveries arriving out of order, plus a duplicate.
 * The machine must never walk backwards.
 */
export function outOfOrderPath(botId = 'lc-outoforder') {
  const o = { streamingOnly: false };
  const joining = ev('bot.joining', botId, { ...o, bot_status: 'Joining' });
  const inmeeting = ev('bot.inmeeting', botId, { ...o, bot_status: 'InMeeting' });
  const recording = ev('bot.recording', botId, { ...o, bot_status: 'Recording' });
  const stopped = stop('bot.stopped', botId, { ...o, bot_status: 'Stopped' });
  return [
    recording,
    // Late arrival, ranks below current state. Recorded, ignored.
    joining,
    // Also late.
    inmeeting,
    stopped,
    // Exact duplicate of the previous delivery (same timestamp).
    stopped,
    ev('manifest.completed', botId, o),
    ev('audio.processed', botId, o),
    ev('transcription.processed', botId, o),
    ev('bot.done', botId, o),
  ];
}

/** Retention expiry after a completed run. data_deletion has no custom_attributes. */
export function deletionPath(botId = 'lc-postcall') {
  const envelope = ev('data_deletion', botId, { message: 'Retention window expired' });
  delete envelope.custom_attributes;
  return [envelope];
}

export function allScenarios() {
  return [
    ...postCallPath(),
    ...streamingOnlyPath(),
    ...kickedPath(),
    ...notAllowedPath(),
    ...deniedPath(),
    ...failurePath(),
    ...outOfOrderPath(),
    ...deletionPath(),
  ];
}

/** POST each envelope to the local server, in order. */
export async function replay(envelopes, url, { delayMs = 60 } = {}) {
  const out = [];
  for (const envelope of envelopes) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    out.push({ event: envelope.event, botId: envelope.bot_id, status: res.status });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  return out;
}
