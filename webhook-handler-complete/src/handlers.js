import { EVENT_CATALOG, STOPPED_REASONS, interpretStatusCode, isTerminal } from './events.js';
import { log } from './logger.js';

/**
 * One handler per documented event.
 *
 * Every handler receives:
 *   env   - the parsed envelope { event, botEvent, reason, botId, botStatus, message,
 *           statusCode, timestamp, customAttributes }
 *   ctx   - { state, raw, expectStreamingOnly } where `state` is the per-bot record
 *
 * Handlers are intentionally side-effect-light. Replace the log lines with your
 * own work (enqueue a job, update a row, notify a channel). Keep the work here
 * FAST: MeetStream expects a prompt 2xx. Anything slow belongs on a queue.
 */

function newBotState(botId) {
  return {
    botId,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    events: [],
    /** Streaming-only provider: no post-call transcript will ever arrive. */
    streamingOnly: false,
    joined: false,
    recorded: false,
    outcome: null, // filled by bot.stopped
    assets: { audio: false, video: false, transcript: false },
    transcriptFailed: false,
    finished: false,
    errors: [],
  };
}

export function ensureState(store, botId) {
  if (!store.has(botId)) store.set(botId, newBotState(botId));
  const s = store.get(botId);
  s.lastSeenAt = new Date().toISOString();
  return s;
}

export const handlers = {
  'bot.joining': (env, { state }) => {
    log.event('bot.joining', env.botId, 'dialing into the meeting');
    state.stage = 'joining';
  },

  'bot.in_waiting_room': (env, { state }) => {
    log.event('bot.in_waiting_room', env.botId, 'waiting for a host to admit the bot');
    log.detail(
      'tip',
      'If nobody admits it, automatic_leave.waiting_room_timeout fires and you get bot.stopped with bot_event=bot.notallowed',
    );
    state.stage = 'waiting_room';
  },

  'bot.inmeeting': (env, { state }) => {
    log.event('bot.inmeeting', env.botId, 'admitted, now a participant');
    state.stage = 'in_meeting';
    state.joined = true;
  },

  'bot.recording': (env, { state }) => {
    log.event('bot.recording', env.botId, 'recording started');
    state.stage = 'recording';
    state.recorded = true;
  },

  'bot.leaving': (env, { state }) => {
    log.event('bot.leaving', env.botId, 'bot is leaving the meeting');
    state.stage = 'leaving';
  },

  /**
   * Ends the meeting phase. Every ending arrives exactly once as this event;
   * the reason is in bot_event (env.reason): bot.stopped | bot.kicked |
   * bot.notallowed | bot.denied | bot.failed. status_code is 200 for a clean
   * exit or a kick and 500 for notallowed / denied / most failures.
   * NOT final: processing events (if anything was recorded) and bot.done follow.
   */
  'bot.stopped': (env, { state }) => {
    const reason = STOPPED_REASONS[env.reason] ?? {
      ok: false,
      hasMedia: null,
      label: `Unknown stop reason "${env.reason}"`,
      detail: 'Not one of bot.stopped | bot.kicked | bot.notallowed | bot.denied | bot.failed. Log and investigate.',
    };

    log.event('bot.stopped', env.botId, `${reason.label} (bot_event=${env.reason})`);
    log.detail('meaning', reason.detail);
    log.detail('bot_status', `${env.botStatus} (informational only, the reason comes from bot_event)`);
    log.detail('status_code', String(env.statusCode));
    if (env.message) log.detail('message', env.message);

    state.stage = 'stopped';
    state.outcome = {
      reason: env.reason,
      botStatus: env.botStatus,
      ok: reason.ok,
      label: reason.label,
      message: env.message,
      at: env.timestamp ?? new Date().toISOString(),
    };

    if (reason.hasMedia === false) {
      log.warn(`bot ${env.botId} never recorded anything. bot.done is the only event still to come.`);
    } else if (!reason.ok) {
      log.warn(`bot ${env.botId} failed. Partial assets may still arrive before bot.done.`);
    }
  },

  /**
   * NON-terminal. A streaming provider hiccuped; the bot is still running.
   * Do not tear down your bot record when you see this.
   */
  'bot.error': (env, { state }) => {
    log.event('bot.error', env.botId, `non-terminal streaming error: ${env.message || 'no message'}`);
    log.detail('important', 'The bot is STILL RUNNING. Expect the lifecycle to continue.');
    state.errors.push({ at: new Date().toISOString(), message: env.message });
  },

  'manifest.completed': (env, { state }) => {
    log.event('manifest.completed', env.botId, 'recording manifest sealed, assets are being produced');
    state.stage = 'processing';
  },

  /**
   * Audio asset ready. NEVER final: bot.done follows on every path.
   * Streaming-only providers (deepgram_streaming, assemblyai_streaming,
   * jigsawstack_streaming, meetstream_streaming, meeting_captions) get no
   * transcription.processed afterwards, so do not wait for or fetch one.
   */
  'audio.processed': (env, { state, expectStreamingOnly }) => {
    log.event('audio.processed', env.botId, 'audio asset ready');
    state.assets.audio = true;
    log.detail('fetch', `GET /bots/${env.botId}/get_audio`);
    if (expectStreamingOnly) {
      log.detail('next', 'Streaming-only provider: no post-call transcript is coming. Wait for bot.done.');
    } else {
      log.detail('next', 'Post-call providers continue to transcription.processed / video.processed / bot.done');
    }
  },

  'transcription.processed': (env, { state }) => {
    log.event('transcription.processed', env.botId, 'post-call transcript ready');
    state.assets.transcript = true;
    log.detail(
      'gotcha',
      'transcript_id is NOT in this webhook. Use the create_bot response, GET /bots/{id}/detail, or GET /bots/{id}/transcriptions',
    );
    log.detail('fetch', 'GET /transcript/{transcript_id}/get_transcript?raw=false');
    log.detail('fields', 'segments carry `speaker` + `transcript` (not `text`)');
  },

  /** Arrives with status_code 500. Post-call providers only. */
  'transcription.failed': (env, { state }) => {
    log.event('transcription.failed', env.botId, `transcription failed: ${env.message || 'no message'}`);
    log.detail('status_code', `${env.statusCode} (500 is expected on this event)`);
    log.detail('retry', `POST /bots/${env.botId}/transcribe re-runs transcription`);
    state.transcriptFailed = true;
    state.errors.push({ at: new Date().toISOString(), message: `transcription failed: ${env.message}` });
  },

  'video.processed': (env, { state }) => {
    log.event('video.processed', env.botId, 'video asset ready');
    state.assets.video = true;
    log.detail('fetch', `GET /bots/${env.botId}/get_video`);
  },

  /**
   * FINAL event on every path: post-call, streaming-only, and bots that never
   * got in. This is the single "session finished" signal. Whether the run
   * succeeded comes from the bot.stopped reason and transcription events, not
   * from this event's status_code.
   */
  'bot.done': (env, { state, expectStreamingOnly }) => {
    log.event('bot.done', env.botId, 'pipeline finished');
    if (env.statusCode !== 200) log.detail('status_code', `${env.statusCode} (unusual on bot.done)`);
    if (expectStreamingOnly) {
      log.detail('transcript', 'streaming-only provider: no post-call transcript exists, do not fetch one');
    }
    state.stage = 'done';
    state.finished = true;
    state.doneOk = (state.outcome?.ok ?? true) && !state.transcriptFailed;
  },

  data_deletion: (env, { state }) => {
    log.event('data_deletion', env.botId, 'bot data deleted');
    log.detail(
      'cause',
      'Either recording_config.retention expired or someone called DELETE /bots/{id}/delete',
    );
    state.stage = 'deleted';
    state.finished = true;
    state.deleted = true;
  },
};

/**
 * Dispatch an envelope to its handler and print the status_code interpretation.
 * Unknown events are logged and ACKed rather than rejected, so a newly added
 * event never causes MeetStream to hammer your endpoint with retries.
 */
export function dispatch(env, ctx) {
  const meta = EVENT_CATALOG[env.event];
  if (!meta) {
    log.warn(`unknown event "${env.event}" for bot ${env.botId}. ACKing so it is not retried.`);
    ctx.state.events.push({ event: env.event, botEvent: env.botEvent, at: env.timestamp ?? new Date().toISOString(), known: false });
    return { handled: false };
  }

  const codeCheck = interpretStatusCode(env.event, env.statusCode ?? 200, env.reason);
  const handler = handlers[env.event];
  handler(env, ctx);

  if (!codeCheck.ok && env.event !== 'transcription.failed') {
    log.warn(`status_code check: ${codeCheck.note}`);
  }

  ctx.state.events.push({
    event: env.event,
    botEvent: env.botEvent,
    botStatus: env.botStatus,
    statusCode: env.statusCode,
    at: env.timestamp ?? new Date().toISOString(),
    known: true,
  });

  if (isTerminal(env.event)) {
    ctx.state.finished = true;
  }

  return { handled: true, phase: meta.phase, terminal: ctx.state.finished === true };
}
