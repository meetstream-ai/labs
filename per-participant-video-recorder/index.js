import 'dotenv/config';
import express from 'express';
import path from 'path';
import logger from './src/logger.js';
import { formatTimestampForFolder, requireEnv, sleep } from './src/utils.js';
import { MeetStreamClient } from './src/meetstream.js';
import { startTunnel } from './src/ngrok.js';
import { createWebhookRouter } from './src/webhook.js';
import {
  hasParticipantAudio,
  hasParticipantVideos,
  processParticipantRecordings,
} from './src/downloader.js';

/**
 * per-participant-video-recorder
 *
 * One-command, fully automated example: starts the server, opens an ngrok
 * tunnel, creates a MeetStream bot configured for Per Participant Video
 * and saves every participant's audio/video recording as soon as the meeting
 * ends - whether that's because the bot left/was kicked out
 * (MeetStream's `bot.stopped` webhook), or because you press Ctrl+C
 * locally.
 *
 * Webhook events this app acts on (the full lifecycle is bot.joining ->
 * bot.in_waiting_room -> bot.inmeeting -> bot.recording -> bot.leaving ->
 * bot.stopped -> audio.processed / manifest.completed -> video.processed ->
 * bot.done, with the stop reason in `bot_event`):
 *   bot.joining, bot.inmeeting, bot.stopped,
 *   audio.processed, video.processed, transcription.processed, data_deletion
 *
 * After `bot.stopped`, per-participant media isn't necessarily ready yet -
 * MeetStream needs a short window to process it. Rather than depend
 * entirely on `video.processed` arriving (webhook deliveries are not
 * retried), this app also does a
 * bounded, interval-based check of `get_recording_streams` until the media
 * is actually available.
 */

const state = {
  client: null,
  outputDir: null,
  botId: null,
  server: null,
  tunnelListener: null,
  finalizing: false,
  finished: false,
  botStopped: false,
  audioWebhookReceived: false,
  videoWebhookReceived: false,
  safetyTimer: null,
  pollAttempts: 0,
  pollIntervalMs: 15_000,
  botStopMaxAttempts: 6,
  botStopRetryMs: 10_000,
};

async function main() {
  logger.info('Starting server...');

  const apiKey = requireEnv('MEETSTREAM_API_KEY');
  const meetingLink = requireEnv('MEETING_LINK');
  const ngrokAuthtoken = requireEnv('NGROK_AUTHTOKEN');
  const botName = process.env.BOT_NAME || 'MeetStream Recorder';
  const port = Number(process.env.PORT || 3000);
  const outputRoot = path.resolve(process.env.OUTPUT_DIR || './recordings');
  const outputDir = path.join(outputRoot, formatTimestampForFolder());
  const maxRetries = Number(process.env.MAX_RETRIES || 5);
  const retryBaseDelayMs = Number(process.env.RETRY_BASE_DELAY_MS || 1000);
  const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 30_000);
  const maxWaitMinutes = Number(process.env.MAX_MEETING_WAIT_MINUTES || 180);
  const ngrokDomain = process.env.NGROK_DOMAIN || undefined;

  state.pollAttempts = Number(process.env.RECORDING_POLL_MAX_ATTEMPTS || 20);
  state.pollIntervalMs = Number(process.env.RECORDING_POLL_INTERVAL_MS || 15_000);
  state.botStopMaxAttempts = Number(process.env.BOT_STOP_MAX_ATTEMPTS || 6);
  state.botStopRetryMs = Number(process.env.BOT_STOP_RETRY_MS || 10_000);
  state.outputDir = outputDir;

  const client = new MeetStreamClient({
    apiKey,
    maxRetries,
    retryBaseDelayMs,
    timeoutMs: requestTimeoutMs,
  });
  state.client = client;

  const app = express();

  const router = createWebhookRouter({
    onEvent: (eventType, payload) => handleWebhookEvent({ eventType, payload }),
  });
  app.use(router);

  state.server = app.listen(port);
  await new Promise((resolve) => state.server.once('listening', resolve));

  const { url, listener } = await startTunnel({
    port,
    authtoken: ngrokAuthtoken,
    domain: ngrokDomain,
  });
  state.tunnelListener = listener;

  const callbackUrl = `${url}/webhook`;
  const bot = await client.createBot({ meetingLink, botName, callbackUrl });
  state.botId = bot.bot_id;

  logger.info('Bot is heading into the meeting...');
  logger.info(
    'Recordings will be saved automatically when the meeting ends - because the bot leaves/gets removed, or because you press Ctrl+C here.'
  );
  logger.info(`This run will save recordings under ${outputDir}`);
  logger.info(`(Safety timeout: will shut down after ${maxWaitMinutes} minutes regardless.)`);

  // Safety net: don't hang forever if nothing else ever triggers finalization.
  state.safetyTimer = setTimeout(async () => {
    if (!state.finished && !state.finalizing) {
      logger.warn('Reached max wait time without the meeting ending. Finalizing now.');
      await finalizeMeeting({ alreadyLeft: false });
    }
  }, maxWaitMinutes * 60 * 1000);
}

/**
 * Why the bot stopped: `bot_event` on a `bot.stopped` delivery
 * (bot.stopped | bot.kicked | bot.notallowed | bot.denied | bot.failed).
 * Falls back to `bot_status`, compared case-insensitively, only when
 * `bot_event` is missing.
 *
 * @param {object} payload
 * @returns {string}
 */
function stopReason(payload) {
  if (payload?.bot_event) return payload.bot_event;
  const status = String(payload?.bot_status ?? '').toLowerCase();
  if (status === 'notallowed') return 'bot.notallowed';
  if (status === 'denied') return 'bot.denied';
  if (status === 'error' || status === 'failed') return 'bot.failed';
  return 'bot.stopped';
}

/**
 * Routes incoming webhook events per MeetStream's real event set.
 *
 * @param {object} params
 * @param {string} params.eventType
 * @param {object} params.payload
 */
async function handleWebhookEvent({ eventType, payload }) {
  switch (eventType) {
    case 'bot.joining':
      logger.debug('Bot is joining the meeting...');
      break;

    case 'bot.inmeeting':
      logger.info('Bot joined meeting');
      break;

    // Terminal lifecycle event - covers the bot leaving on its own,
    // being kicked/removed by a host, timing out in a waiting room, or
    // erroring out. bot_event carries the reason (bot_status can't tell a
    // kick from a clean exit, and its failure casing varies).
    case 'bot.stopped': {
      state.botStopped = true;
      const reason = stopReason(payload);
      if (reason === 'bot.stopped') {
        logger.info('Bot left the meeting.');
      } else if (reason === 'bot.kicked') {
        logger.info('Bot was removed from the meeting by a participant.');
      } else {
        logger.error(`Bot stopped abnormally (${reason}): ${payload.message ?? ''}`);
      }
      await finalizeMeeting({ alreadyLeft: true });
      break;
    }

    // Post-call processing events. Use them as a fast path if they arrive;
    // otherwise the poll loop in finalizeMeeting() catches it anyway.
    case 'video.processed':
      logger.info('MeetStream reports video processing complete.');
      state.videoWebhookReceived = true;
      break;

    case 'audio.processed':
      logger.info('MeetStream reports audio processing complete.');
      state.audioWebhookReceived = true;
      break;

    case 'transcription.processed':
      logger.debug('Transcription processing complete (not used by this app).');
      break;

    case 'data_deletion':
      logger.info('MeetStream reports this bot\'s data has been deleted.');
      break;

    default:
      // Unknown/future event types are logged (in webhook.js) and
      // otherwise ignored.
      break;
  }
}

/**
 * The single place that "the meeting is over" funnels into. Safe to call
 * multiple times (from a webhook, the safety timer, and/or Ctrl+C) - only
 * runs once.
 *
 * @param {object} params
 * @param {boolean} params.alreadyLeft - true if MeetStream already reports
 *   the bot as out of the meeting; false if we need to actively remove it
 *   (e.g. on local Ctrl+C while the bot is still in the call).
 */
async function finalizeMeeting({ alreadyLeft }) {
  if (state.finalizing || state.finished) return;
  state.finalizing = true;
  if (state.safetyTimer) clearTimeout(state.safetyTimer);

  const { client, botId, outputDir } = state;

  try {
    if (!alreadyLeft && botId) {
      logger.info('Removing bot from the meeting...');
      await removeBotUntilStopped({ client, botId });
    }

    const { videoData, audioData } = await waitForRecordings({ client, botId });
    await processParticipantRecordings({ videoData, audioData, client, outputDir });
  } catch (err) {
    logger.error(`Failed while finalizing the meeting: ${err.message}`);
  } finally {
    state.finished = true;
    await shutdown();
  }
}

/**
 * Send remove_bot more than once if MeetStream accepts the stop signal but
 * never confirms `bot.stopped`. Without this, recording polling starts while
 * the bot is still in the meeting, and MeetStream keeps returning 404.
 *
 * @param {object} params
 * @param {MeetStreamClient} params.client
 * @param {string} params.botId
 */
async function removeBotUntilStopped({ client, botId }) {
  for (let attempt = 1; attempt <= state.botStopMaxAttempts; attempt += 1) {
    if (attempt > 1) {
      logger.info(
        `Bot stop not confirmed yet. Sending remove signal again (${attempt}/${state.botStopMaxAttempts})...`
      );
    }

    const result = await client.removeBot(botId);
    if (result.alreadyGone) {
      state.botStopped = true;
      return;
    }
    if (await waitForBotStopped(state.botStopRetryMs)) return;
  }

  logger.warn(
    'Bot stop was not confirmed. The bot may still be in the meeting; recording polling will fail fast if processing has not started.'
  );
}

/**
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForBotStopped(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.botStopped || state.videoWebhookReceived || state.audioWebhookReceived) return true;
    await sleep(Math.min(500, deadline - Date.now()));
  }
  return state.botStopped || state.videoWebhookReceived || state.audioWebhookReceived;
}

/**
 * MeetStream needs some time after a bot leaves to process and expose
 * per-participant recordings. Poll the video/audio streams endpoints with a fixed
 * interval and a bounded number of attempts (not indefinite), since webhook
 * delivery for `video.processed` is documented as best-effort and not retried.
 *
 * @param {object} params
 * @param {MeetStreamClient} params.client
 * @param {string} params.botId
 * @returns {Promise<{ videoData: object|null, audioData: object|null }>}
 */
async function waitForRecordings({ client, botId }) {
  if (!botId) {
    logger.warn('No bot_id available to fetch recordings with.');
    return { videoData: null, audioData: null };
  }

  let videoData = null;
  let audioData = null;
  let videoReady = false;
  let audioReady = false;

  for (let attempt = 1; attempt <= state.pollAttempts; attempt += 1) {
    logger.info(
      `Checking whether recordings are ready (attempt ${attempt}/${state.pollAttempts})...`
    );

    if (!videoReady) {
      try {
        const res = await client.getRecordingStreams(botId);
        videoData = res.data;
        videoReady = res.ready && hasParticipantVideos(videoData);
        if (res.ready && !videoReady) {
          logger.info('Video endpoint is ready, but no downloadable participant videos were returned yet.');
        }
      } catch (err) {
        if (isVideoProcessingNotStarted(err) && !state.botStopped && !state.videoWebhookReceived) {
          throw new Error(
            'MeetStream has not started video processing, and bot.stopped was never confirmed. The bot may still be in the meeting.'
          );
        }
        logger.warn(
          `Video recording status check failed: ${err.message}` +
            (err.response?.data ? ` - body: ${JSON.stringify(err.response.data)}` : '')
        );
      }
    }

    if (!audioReady) {
      try {
        const res = await client.getAudioStreams(botId);
        audioData = res.data;
        audioReady = res.ready && hasParticipantAudio(audioData);
        if (res.ready && !audioReady) {
          logger.info('Audio endpoint is ready, but no downloadable participant audio was returned yet.');
        }
      } catch (err) {
        logger.warn(
          `Audio recording status check failed: ${err.message}` +
            (err.response?.data ? ` - body: ${JSON.stringify(err.response.data)}` : '')
        );
      }
    }

    if (videoReady && audioReady) {
      logger.info('Audio and video recordings are ready.');
      break;
    }

    if (attempt < state.pollAttempts) {
      logger.info(
        `Recordings not ready yet (video: ${videoReady ? 'ready' : 'waiting'}, audio: ${
          audioReady ? 'ready' : 'waiting'
        }). Retrying in ${Math.round(state.pollIntervalMs / 1000)}s...`
      );
      await sleep(state.pollIntervalMs);
    }
  }

  if (!videoReady) logger.warn('Gave up waiting for downloadable participant videos - proceeding without them.');
  if (!audioReady) logger.warn('Gave up waiting for downloadable participant audio - proceeding without it.');

  await dumpDebugResponses({ videoData, audioData });

  return { videoData, audioData };
}

/**
 * @param {any} err
 * @returns {boolean}
 */
function isVideoProcessingNotStarted(err) {
  return (
    err.response?.status === 404 &&
    /No video processing has been initiated/i.test(JSON.stringify(err.response.data ?? ''))
  );
}

/**
 * Writes whatever raw JSON MeetStream actually returned to
 * `<outputDir>/debug_video_response.json` / `debug_audio_response.json`,
 * regardless of whether we could make sense of it. This project's earlier
 * assumptions about MeetStream's exact response shape turned out to be
 * unreliable (MeetStream's own docs show a copy-pasted placeholder example
 * on multiple different endpoint pages), so rather than guess again, these
 * files let us see the real shape directly and fix the parsing to match.
 *
 * @param {object} params
 * @param {object|null} params.videoData
 * @param {object|null} params.audioData
 */
async function dumpDebugResponses({ videoData, audioData }) {
  try {
    const fs = await import('fs-extra');
    await fs.default.ensureDir(state.outputDir);
    if (videoData) {
      await fs.default.writeJson(path.join(state.outputDir, 'debug_video_response.json'), videoData, {
        spaces: 2,
      });
    }
    if (audioData) {
      await fs.default.writeJson(path.join(state.outputDir, 'debug_audio_response.json'), audioData, {
        spaces: 2,
      });
    }
    logger.info(`Raw API responses dumped to ${state.outputDir} for debugging.`);
  } catch (err) {
    logger.debug(`Could not write debug response dumps: ${err.message}`);
  }
}

/**
 * Tear down the ngrok tunnel and close the HTTP server, then exit.
 */
async function shutdown() {
  if (state.tunnelListener) {
    try {
      await state.tunnelListener.close();
    } catch (err) {
      logger.debug(`Tunnel already closed: ${err.message}`);
    }
  }

  if (state.server) {
    await new Promise((resolve) => state.server.close(resolve));
  }

  logger.info('Meeting complete');
  process.exit(0);
}

// Ctrl+C: remove the bot from the meeting and save whatever recordings
// MeetStream has ready, instead of just exiting.
let sigintReceived = false;
process.on('SIGINT', async () => {
  if (sigintReceived) {
    logger.warn('Force-quitting without saving (second Ctrl+C).');
    process.exit(1);
  }
  sigintReceived = true;

  logger.info('Received Ctrl+C - removing the bot and saving recordings before exiting...');
  logger.info('(Press Ctrl+C again to force-quit immediately without saving.)');
  await finalizeMeeting({ alreadyLeft: false });
});

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
