/**
 * Offline exercise of the handler.
 *
 * These are synthetic envelopes shaped exactly like the real ones, POSTed to
 * your own server so you can watch every branch fire without booking a meeting.
 * Nothing here talks to the MeetStream API.
 */

const base = (event, extra = {}) => ({
  event,
  bot_id: extra.bot_id,
  bot_status: extra.bot_status ?? null,
  message: extra.message ?? '',
  status_code: extra.status_code ?? 200,
  custom_attributes: extra.custom_attributes ?? {},
});

/** Happy path with a post-call provider: ends at bot.done. */
export function postCallHappyPath(botId = 'sim-postcall-1') {
  const a = { bot_id: botId, custom_attributes: { scenario: 'post-call-happy', streaming_only: 'false' } };
  return [
    base('bot.joining', { ...a, bot_status: 'Joining', message: 'Bot is joining' }),
    base('bot.in_waiting_room', { ...a, bot_status: 'InWaitingRoom', message: 'Waiting for host' }),
    base('bot.inmeeting', { ...a, bot_status: 'InMeeting', message: 'Bot joined' }),
    base('bot.recording', { ...a, bot_status: 'Recording', message: 'Recording started' }),
    base('bot.leaving', { ...a, bot_status: 'Leaving', message: 'Bot is leaving' }),
    // Terminal for the meeting phase, always 200.
    base('bot.stopped', { ...a, bot_status: 'Stopped', message: 'Bot left the meeting' }),
    base('manifest.completed', { ...a, message: 'Manifest sealed' }),
    base('audio.processed', { ...a, message: 'Audio ready' }),
    base('transcription.processed', { ...a, message: 'Transcript ready' }),
    base('video.processed', { ...a, message: 'Video ready' }),
    base('bot.done', { ...a, message: 'All done' }),
  ];
}

/** Streaming-only provider: the pipeline STOPS at audio.processed. */
export function streamingOnlyPath(botId = 'sim-streaming-1') {
  // `streaming_only` is stamped into custom_attributes at create_bot time so the
  // handler knows audio.processed is terminal for this bot. Values must be strings.
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
    base('bot.stopped', { ...a, bot_status: 'Stopped' }),
    base('manifest.completed', { ...a }),
    // Terminal. No bot.done will ever arrive for a streaming-only bot.
    base('audio.processed', { ...a, message: 'Audio ready' }),
  ];
}

/** Host never admitted the bot. status_code is still 200. */
export function lobbyTimeoutPath(botId = 'sim-notallowed-1') {
  const a = { bot_id: botId, custom_attributes: { scenario: 'lobby-timeout', streaming_only: 'false' } };
  return [
    base('bot.joining', { ...a, bot_status: 'Joining' }),
    base('bot.in_waiting_room', { ...a, bot_status: 'InWaitingRoom' }),
    base('bot.stopped', {
      ...a,
      bot_status: 'NotAllowed',
      message: 'Waiting room timeout reached',
      status_code: 200,
    }),
  ];
}

/** Host clicked deny. Also 200. */
export function deniedPath(botId = 'sim-denied-1') {
  const a = { bot_id: botId, custom_attributes: { scenario: 'denied', streaming_only: 'false' } };
  return [
    base('bot.joining', { ...a, bot_status: 'Joining' }),
    base('bot.in_waiting_room', { ...a, bot_status: 'InWaitingRoom' }),
    base('bot.stopped', { ...a, bot_status: 'Denied', message: 'Host denied entry', status_code: 200 }),
  ];
}

/** Bot errored mid-meeting, then transcription failed with a real 500. */
export function transcriptionFailurePath(botId = 'sim-failed-1') {
  const a = { bot_id: botId, custom_attributes: { scenario: 'transcription-failure', streaming_only: 'false' } };
  return [
    base('bot.joining', { ...a, bot_status: 'Joining' }),
    base('bot.inmeeting', { ...a, bot_status: 'InMeeting' }),
    base('bot.recording', { ...a, bot_status: 'Recording' }),
    base('bot.stopped', { ...a, bot_status: 'Error', message: 'Meeting ended unexpectedly' }),
    base('manifest.completed', { ...a }),
    base('audio.processed', { ...a }),
    // One of only two events that carries 500.
    base('transcription.failed', { ...a, message: 'ASR provider returned an error', status_code: 500 }),
    base('bot.done', { ...a, message: 'Finished with errors', status_code: 500 }),
  ];
}

/** Retention window expired (or DELETE /bots/{id}/delete was called). */
export function deletionPath(botId = 'sim-postcall-1') {
  return [base('data_deletion', { bot_id: botId, message: 'Bot data deleted per retention policy' })];
}

/**
 * Every scenario, plus a deliberate duplicate delivery so you can watch the
 * dedupe layer swallow it.
 */
export function allScenarios() {
  const happy = postCallHappyPath();
  return [
    ...happy,
    // At-least-once delivery in action: MeetStream resends bot.recording.
    happy[3],
    ...streamingOnlyPath(),
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
