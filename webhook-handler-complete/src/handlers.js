import { EVENT_CATALOG, STOPPED_REASONS, interpretStatusCode, isTerminalFor } from './events.js';
import { log } from './logger.js';

/**
 * One handler per documented event.
 *
 * Every handler receives:
 *   env   - the parsed envelope { event, botId, botStatus, message, statusCode, customAttributes }
 *   ctx   - { state, raw } where `state` is the per-bot record this process keeps
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
    /** Set once we learn the run was streaming-only (audio.processed with no bot.done path). */
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
      'If nobody admits it, automatic_leave.waiting_room_timeout fires and you get bot.stopped with bot_status=NotAllowed',
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
   * TERMINAL for the meeting phase.
   * status_code is ALWAYS 200 here, whatever happened. The reason lives in
   * bot_status: Stopped | NotAllowed | Denied | Error.
   */
  'bot.stopped': (env, { state }) => {
    const reason = STOPPED_REASONS[env.botStatus] ?? {
      ok: false,
      label: `Unknown bot_status "${env.botStatus}"`,
      detail: 'Not one of Stopped | NotAllowed | Denied | Error. Log and investigate.',
    };

    log.event('bot.stopped', env.botId, `${reason.label} (bot_status=${env.botStatus})`);
    log.detail('meaning', reason.detail);
    log.detail('status_code', `${env.statusCode} (always 200 on bot.stopped, do not read it as success)`);
    if (env.message) log.detail('message', env.message);

    state.stage = 'stopped';
    state.outcome = {
      botStatus: env.botStatus,
      ok: reason.ok,
      label: reason.label,
      message: env.message,
      at: new Date().toISOString(),
    };

    if (!reason.ok) {
      // No media exists for NotAllowed / Denied. Nothing further will arrive,
      // so close the book on this bot now instead of waiting for bot.done.
      if (env.botStatus === 'NotAllowed' || env.botStatus === 'Denied') {
        state.finished = true;
        log.warn(`bot ${env.botId} never recorded anything. No processing events will follow.`);
      } else {
        log.warn(`bot ${env.botId} stopped with an error. Partial assets may still arrive.`);
      }
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
   * TERMINAL for streaming-only transcription providers
   * (deepgram_streaming, assemblyai_streaming, jigsawstack_streaming,
   *  meetstream_streaming, meeting_captions). Those never emit bot.done.
   */
  'audio.processed': (env, { state, expectStreamingOnly }) => {
    log.event('audio.processed', env.botId, 'audio asset ready');
    state.assets.audio = true;
    if (expectStreamingOnly) {
      state.streamingOnly = true;
      state.finished = true;
      log.ok(
        `bot ${env.botId} pipeline COMPLETE. Streaming-only providers end here and never send bot.done.`,
      );
      log.detail('fetch', `GET /bots/${env.botId}/get_audio`);
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

  /** Arrives with status_code 500. One of only two events that ever does. */
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
   * TERMINAL for post-call providers. status_code 500 here means the run
   * finished unsuccessfully.
   */
  'bot.done': (env, { state }) => {
    const failed = env.statusCode === 500;
    log.event('bot.done', env.botId, failed ? 'pipeline finished UNSUCCESSFULLY' : 'pipeline finished');
    log.detail('status_code', `${env.statusCode}${failed ? ' (failure)' : ''}`);
    state.stage = 'done';
    state.finished = true;
    state.doneOk = !failed;
    if (failed) {
      state.errors.push({ at: new Date().toISOString(), message: env.message || 'bot.done reported 500' });
    }
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
    ctx.state.events.push({ event: env.event, at: new Date().toISOString(), known: false });
    return { handled: false };
  }

  const codeCheck = interpretStatusCode(env.event, env.statusCode ?? 200);
  const handler = handlers[env.event];
  handler(env, ctx);

  if (!codeCheck.ok && env.event !== 'transcription.failed' && env.event !== 'bot.done') {
    log.warn(`status_code check: ${codeCheck.note}`);
  }

  ctx.state.events.push({
    event: env.event,
    botStatus: env.botStatus,
    statusCode: env.statusCode,
    at: new Date().toISOString(),
    known: true,
  });

  if (isTerminalFor(env.event, { streamingOnly: ctx.expectStreamingOnly })) {
    ctx.state.finished = true;
  }

  return { handled: true, phase: meta.phase, terminal: ctx.state.finished === true };
}
