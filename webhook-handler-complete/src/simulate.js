/**
 * Offline exercise of the handler.
 *
 * These are synthetic envelopes shaped exactly like the real ones, POSTed to
 * your own server so you can watch every branch fire without booking a meeting.
 * Nothing here talks to the MeetStream API.
 *
 * Shape rules they follow (same as production):
 *   - `event` is always present; `bot_event` equals it except on terminals and
 *     is absent on manifest.completed.
 *   - every ending is `event: "bot.stopped"` with the reason in `bot_event`.
 *   - every delivery carries an ISO 8601 `timestamp`.
 *   - every path ends with `bot.done`.
 */

/** Monotonic fake clock so every envelope gets a distinct, ordered timestamp. */
let clock = Date.parse('2026-06-18T17:00:00.000Z');
const nextTimestamp = () => new Date((clock += 1500)).toISOString();

/** Events that never carry `bot_event` in production. */
const NO_BOT_EVENT = new Set(['manifest.completed']);

const base = (event, extra = {}) => {
  const envelope = {
    event,
    bot_id: extra.bot_id,
    bot_status: extra.bot_status ?? null,
    message: extra.message ?? '',
    status_code: extra.status_code ?? 200,
    timestamp: nextTimestamp(),
    custom_attributes: extra.custom_attributes ?? {},
  };
  if (!NO_BOT_EVENT.has(event)) envelope.bot_event = extra.bot_event ?? event;
  return envelope;
};

/** A terminal: always `event: "bot.stopped"`, reason in `bot_event`. */
const stopped = (reason, extra) => base('bot.stopped', { ...extra, bot_event: reason });

/** Happy path with a post-call provider: ends at bot.done. */
export function postCallHappyPath(botId = 'sim-postcall-1') {
  const a = { bot_id: botId, custom_attributes: { scenario: 'post-call-happy', streaming_only: 'false' } };
  return [
    base('bot.joining', { ...a, bot_status: 'Joining', message: 'Bot is joining' }),
    base('bot.in_waiting_room', { ...a, bot_status: 'InWaitingRoom', message: 'Waiting for host' }),
    base('bot.inmeeting', { ...a, bot_status: 'InMeeting', message: 'Bot joined' }),
    base('bot.recording', { ...a, bot_status: 'Recording', message: 'Recording started' }),
    base('bot.leaving', { ...a, bot_status: 'Leaving', message: 'Bot is leaving' }),
    // Clean exit: bot_event bot.stopped, status_code 200.
    stopped('bot.stopped', { ...a, bot_status: 'Stopped', message: 'Bot left the meeting' }),
    base('manifest.completed', { ...a, message: 'Manifest sealed' }),
    base('audio.processed', { ...a, message: 'Audio ready' }),
    base('transcription.processed', { ...a, message: 'Transcript ready' }),
    base('video.processed', { ...a, message: 'Video ready' }),
    base('bot.done', { ...a, message: 'All done' }),
  ];
}

/**
 * Streaming-only provider: no transcription.processed ever arrives, but the
 * stream still ends with bot.done. audio.processed is NOT final.
 */
export function streamingOnlyPath(botId = 'sim-streaming-1') {
  // `streaming_only` is stamped into custom_attributes at create_bot time so the
  // handler knows no post-call transcript is coming. Values must be strings.
  const a = {
    bot_id: botId,
    custom_attributes: { scenario: 'streaming-only', streaming_only: 'true' },
  };
  return [
    base('bot.joining', { ...a, bot_status: 'Joining' }),
    base('bot.inmeeting', { ...a, bot_status: 'InMeeting' }),
    base('bot.recording', { ...a, bot_status: 'Recording' }),
    // Non-terminal. The bot keeps going after this.
    base('bot.error', { ...a, message: 'deepgram_streaming socket reconnected' }),
    base('bot.leaving', { ...a, bot_status: 'Leaving' }),
    stopped('bot.stopped', { ...a, bot_status: 'Stopped' }),
    base('manifest.completed', { ...a }),
    base('audio.processed', { ...a, message: 'Audio ready' }),
    // Final event, same as every other path.
    base('bot.done', { ...a, message: 'All done' }),
  ];
}

/** A participant removed the bot. bot_status says "Stopped", bot_event says kicked. */
export function kickedPath(botId = 'sim-kicked-1') {
  const a = { bot_id: botId, custom_attributes: { scenario: 'kicked', streaming_only: 'false' } };
  return [
    base('bot.joining', { ...a, bot_status: 'Joining' }),
    base('bot.inmeeting', { ...a, bot_status: 'InMeeting' }),
    base('bot.recording', { ...a, bot_status: 'Recording' }),
    base('bot.leaving', { ...a, bot_status: 'Leaving' }),
    stopped('bot.kicked', { ...a, bot_status: 'Stopped', message: 'Bot was removed by a participant' }),
    base('manifest.completed', { ...a }),
    base('audio.processed', { ...a }),
    base('transcription.processed', { ...a }),
    base('bot.done', { ...a }),
  ];
}

/** Host never admitted the bot: bot_event bot.notallowed, status_code 500. */
export function lobbyTimeoutPath(botId = 'sim-notallowed-1') {
  const a = { bot_id: botId, custom_attributes: { scenario: 'lobby-timeout', streaming_only: 'false' } };
  return [
    base('bot.joining', { ...a, bot_status: 'Joining' }),
    base('bot.in_waiting_room', { ...a, bot_status: 'InWaitingRoom' }),
    base('bot.leaving', { ...a, bot_status: 'Leaving' }),
    stopped('bot.notallowed', {
      ...a,
      bot_status: 'NotAllowed',
      message: 'Waiting room timeout reached',
      status_code: 500,
    }),
    // Nothing was recorded, but bot.done still closes the stream.
    base('bot.done', { ...a }),
  ];
}

/** Host clicked deny: bot_event bot.denied, status_code 500. */
export function deniedPath(botId = 'sim-denied-1') {
  const a = { bot_id: botId, custom_attributes: { scenario: 'denied', streaming_only: 'false' } };
  return [
    base('bot.joining', { ...a, bot_status: 'Joining' }),
    base('bot.in_waiting_room', { ...a, bot_status: 'InWaitingRoom' }),
    base('bot.leaving', { ...a, bot_status: 'Leaving' }),
    stopped('bot.denied', { ...a, bot_status: 'Denied', message: 'Host denied entry', status_code: 500 }),
    base('bot.done', { ...a }),
  ];
}

/** Bot crashed mid-meeting, then transcription failed with a real 500. */
export function transcriptionFailurePath(botId = 'sim-failed-1') {
  const a = { bot_id: botId, custom_attributes: { scenario: 'transcription-failure', streaming_only: 'false' } };
  return [
    base('bot.joining', { ...a, bot_status: 'Joining' }),
    base('bot.inmeeting', { ...a, bot_status: 'InMeeting' }),
    base('bot.recording', { ...a, bot_status: 'Recording' }),
    // Failure casing varies in bot_status (FAILED / ERROR / Failed); bot_event does not.
    stopped('bot.failed', { ...a, bot_status: 'FAILED', message: 'Meeting ended unexpectedly', status_code: 500 }),
    base('manifest.completed', { ...a }),
    base('audio.processed', { ...a }),
    base('transcription.failed', { ...a, message: 'ASR provider returned an error', status_code: 500 }),
    base('bot.done', { ...a, message: 'Finished' }),
  ];
}

/** Retention window expired (or DELETE /bots/{id}/delete was called). No custom_attributes. */
export function deletionPath(botId = 'sim-postcall-1') {
  const envelope = base('data_deletion', { bot_id: botId, message: 'Bot data deleted per retention policy' });
  delete envelope.custom_attributes;
  return [envelope];
}

/**
 * Every scenario, plus a deliberate duplicate delivery so you can watch the
 * dedupe layer swallow it.
 */
export function allScenarios() {
  const happy = postCallHappyPath();
  return [
    ...happy,
    // At-least-once delivery in action: MeetStream resends bot.recording
    // (same body, same timestamp).
    happy[3],
    ...streamingOnlyPath(),
    ...kickedPath(),
    ...lobbyTimeoutPath(),
    ...deniedPath(),
    ...transcriptionFailurePath(),
    ...deletionPath(),
  ];
}

/** POST each envelope to the local server, in order. */
export async function replay(envelopes, url, { delayMs = 120 } = {}) {
  const results = [];
  for (const envelope of envelopes) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    results.push({ event: envelope.event, botId: envelope.bot_id, status: res.status });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  return results;
}
