/**
 * Synthetic webhook sequences for exercising the machine offline.
 *
 * Shaped exactly like real deliveries. Nothing here calls the API.
 */

const ev = (event, botId, extra = {}) => ({
  event,
  bot_id: botId,
  bot_status: extra.bot_status ?? null,
  message: extra.message ?? '',
  status_code: extra.status_code ?? 200,
  custom_attributes: {
    streaming_only: String(Boolean(extra.streamingOnly)),
    ...(extra.custom_attributes ?? {}),
  },
});

/** Post-call provider. Ends at bot.done. */
export function postCallPath(botId = 'lc-postcall') {
  const o = { streamingOnly: false };
  return [
    ev('bot.joining', botId, { ...o, bot_status: 'Joining' }),
    ev('bot.in_waiting_room', botId, { ...o, bot_status: 'InWaitingRoom' }),
    ev('bot.inmeeting', botId, { ...o, bot_status: 'InMeeting' }),
    ev('bot.recording', botId, { ...o, bot_status: 'Recording' }),
    ev('bot.leaving', botId, { ...o, bot_status: 'Leaving' }),
    ev('bot.stopped', botId, { ...o, bot_status: 'Stopped', message: 'Left cleanly' }),
    ev('manifest.completed', botId, o),
    ev('audio.processed', botId, o),
    ev('transcription.processed', botId, o),
    ev('video.processed', botId, o),
    ev('bot.done', botId, o),
  ];
}

/** Streaming-only provider. Ends at audio.processed. No bot.done, ever. */
export function streamingOnlyPath(botId = 'lc-streaming') {
  const o = { streamingOnly: true };
  return [
    ev('bot.joining', botId, { ...o, bot_status: 'Joining' }),
    ev('bot.inmeeting', botId, { ...o, bot_status: 'InMeeting' }),
    ev('bot.recording', botId, { ...o, bot_status: 'Recording' }),
    // Non-terminal: the machine must not move for this.
    ev('bot.error', botId, { ...o, message: 'streaming socket reconnected' }),
    ev('bot.stopped', botId, { ...o, bot_status: 'Stopped' }),
    ev('manifest.completed', botId, o),
    ev('audio.processed', botId, o),
  ];
}

/** Lobby timeout. bot.stopped with NotAllowed, status_code still 200. */
export function notAllowedPath(botId = 'lc-notallowed') {
  const o = { streamingOnly: false };
  return [
    ev('bot.joining', botId, { ...o, bot_status: 'Joining' }),
    ev('bot.in_waiting_room', botId, { ...o, bot_status: 'InWaitingRoom' }),
    ev('bot.stopped', botId, {
      ...o,
      bot_status: 'NotAllowed',
      message: 'Waiting room timeout',
      status_code: 200,
    }),
  ];
}

/** Host denied entry. */
export function deniedPath(botId = 'lc-denied') {
  const o = { streamingOnly: false };
  return [
    ev('bot.joining', botId, { ...o, bot_status: 'Joining' }),
    ev('bot.in_waiting_room', botId, { ...o, bot_status: 'InWaitingRoom' }),
    ev('bot.stopped', botId, { ...o, bot_status: 'Denied', message: 'Host denied the bot' }),
  ];
}

/** Errored in-meeting, transcription failed (500), pipeline finished failed (500). */
export function failurePath(botId = 'lc-failed') {
  const o = { streamingOnly: false };
  return [
    ev('bot.joining', botId, { ...o, bot_status: 'Joining' }),
    ev('bot.inmeeting', botId, { ...o, bot_status: 'InMeeting' }),
    ev('bot.recording', botId, { ...o, bot_status: 'Recording' }),
    ev('bot.stopped', botId, { ...o, bot_status: 'Error', message: 'Bot crashed mid-meeting' }),
    ev('manifest.completed', botId, o),
    ev('audio.processed', botId, o),
    ev('transcription.failed', botId, { ...o, message: 'ASR provider error', status_code: 500 }),
    ev('bot.done', botId, { ...o, message: 'Finished with errors', status_code: 500 }),
  ];
}

/**
 * Deliveries arriving out of order, plus a duplicate.
 * The machine must never walk backwards.
 */
export function outOfOrderPath(botId = 'lc-outoforder') {
  const o = { streamingOnly: false };
  return [
    ev('bot.recording', botId, { ...o, bot_status: 'Recording' }),
    // Late arrival, ranks below current state. Recorded, ignored.
    ev('bot.joining', botId, { ...o, bot_status: 'Joining' }),
    // Also late.
    ev('bot.inmeeting', botId, { ...o, bot_status: 'InMeeting' }),
    ev('bot.stopped', botId, { ...o, bot_status: 'Stopped' }),
    // Exact duplicate of the previous delivery.
    ev('bot.stopped', botId, { ...o, bot_status: 'Stopped' }),
    ev('manifest.completed', botId, o),
    ev('audio.processed', botId, o),
    ev('transcription.processed', botId, o),
    ev('bot.done', botId, o),
  ];
}

/** Retention expiry after a completed run. */
export function deletionPath(botId = 'lc-postcall') {
  return [ev('data_deletion', botId, { message: 'Retention window expired' })];
}

export function allScenarios() {
  return [
    ...postCallPath(),
    ...streamingOnlyPath(),
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
