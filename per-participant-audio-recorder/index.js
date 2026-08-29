import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { MeetStreamClient, interpretBotStatus } from './src/client.js';
import { log } from './src/log.js';
import {
  downloadParticipantAudio,
  dumpRawResponse,
  fetchAudioStreams,
  groupStreamsByParticipant,
} from './src/streams.js';
import { createWaiter, envBool, envInt, optionalEnv, requireEnv, timestampSlug } from './src/util.js';
import { createWebhookApp, listen } from './src/webhook.js';

/**
 * per-participant-audio-recorder
 *
 * Records a meeting and downloads one audio file per participant from
 * `GET /bots/{bot_id}/get_audio_streams`.
 *
 * The heart of this template is correct 202 handling. Per-participant audio is
 * produced by post-processing the recording, so the endpoint answers 202
 * ("still working") until it is done. Two rules follow from that:
 *
 *   1. 202 is NOT an error. Never throw on it, never treat the body as media.
 *   2. Polling MUST be capped. A bot using a streaming-only transcription
 *      provider produces no post-call per-participant audio at all, and the
 *      endpoint will answer 202 indefinitely. An uncapped loop would hang
 *      forever.
 */

const state = {
  client: null,
  botId: null,
  server: null,
  audioReady: false,
  botStopped: false,
  removeRequested: false,
  waiter: createWaiter(),
};

async function main() {
  const apiKey = requireEnv('MEETSTREAM_API_KEY');
  const meetingLink = requireEnv('MEETING_LINK');
  const botName = optionalEnv('BOT_NAME', 'MeetStream Participant Recorder');
  const publicWebhookUrl = optionalEnv('PUBLIC_WEBHOOK_URL');
  const port = envInt('PORT', 3000);
  const outputRoot = path.resolve(optionalEnv('OUTPUT_DIR', './recordings'));
  const meetingMaxAttempts = envInt('MEETING_POLL_MAX_ATTEMPTS', 240);
  const meetingIntervalMs = envInt('MEETING_POLL_INTERVAL_MS', 15_000);
  const streamsMaxAttempts = envInt('STREAMS_POLL_MAX_ATTEMPTS', 40);
  const streamsIntervalMs = envInt('STREAMS_POLL_INTERVAL_MS', 15_000);
  const separateStreams = envBool('AUDIO_SEPARATE_STREAMS', true);
  const everyoneLeftTimeout = envInt('EVERYONE_LEFT_TIMEOUT', 60);

  const client = new MeetStreamClient({
    apiKey,
    timeoutMs: envInt('REQUEST_TIMEOUT_MS', 30_000),
    maxRetries: envInt('MAX_RETRIES', 4),
  });
  state.client = client;

  let callbackUrl;
  if (publicWebhookUrl) {
    const app = createWebhookApp({ onEvent: handleEvent });
    state.server = await listen({ app, port });
    callbackUrl = `${publicWebhookUrl.replace(/\/+$/, '')}/webhook`;
    log.info(`Webhook server listening on port ${port}, public URL ${callbackUrl}`);
  } else {
    log.warn('PUBLIC_WEBHOOK_URL is not set - running in poll-only mode (no webhooks).');
  }

  const payload = {
    meeting_link: meetingLink,
    bot_name: botName,
    video_required: false,
    automatic_leave: {
      everyone_left_timeout: everyoneLeftTimeout,
    },
  };
  if (callbackUrl) payload.callback_url = callbackUrl;

  // Per-participant audio is requested with `audio_separate_streams`, the same
  // flag the per-participant-video-recorder template in this repo uses. If
  // your account rejects it with a 400, set AUDIO_SEPARATE_STREAMS=false and
  // check with MeetStream support whether it is enabled for your plan.
  if (separateStreams) payload.audio_separate_streams = true;

  log.info(`Creating bot for ${meetingLink} ...`);
  const bot = await client.createBot(payload, { idempotencyKey: randomUUID() });
  state.botId = bot.bot_id;
  log.info(`Bot created: bot_id=${bot.bot_id} status=${bot.status ?? 'unknown'}`);

  const destDir = path.join(outputRoot, `${timestampSlug()}_${bot.bot_id}`);
  log.info(`Per-participant audio will be saved under ${destDir}`);
  log.info('Press Ctrl+C to pull the bot out of the meeting and download whatever is ready.');

  await waitForMeetingToEnd({
    client,
    botId: bot.bot_id,
    maxAttempts: meetingMaxAttempts,
    intervalMs: meetingIntervalMs,
  });

  const streams = await pollAudioStreams({
    client,
    botId: bot.bot_id,
    maxAttempts: streamsMaxAttempts,
    intervalMs: streamsIntervalMs,
  });

  const rawPath = await dumpRawResponse(destDir, streams.data);
  log.debug(`Raw get_audio_streams body saved to ${rawPath}`);

  const groups = groupStreamsByParticipant(streams.data);
  if (groups.length === 0) {
    log.warn(`No downloadable participant audio was returned. Inspect ${rawPath}.`);
    await shutdown(0);
    return;
  }

  log.info(`${groups.length} participant stream group(s) ready.`);
  const { saved, failed } = await downloadParticipantAudio({ groups, destDir });
  log.info(`Saved ${saved} file(s) to ${destDir}${failed ? `, ${failed} failed` : ''}.`);

  await shutdown(failed > 0 ? 1 : 0);
}

/**
 * @param {string} event
 * @param {any} payload
 */
function handleEvent(event, payload) {
  switch (event) {
    case 'bot.inmeeting':
      log.info('Bot is in the meeting.');
      break;
    case 'bot.recording':
      log.info('Recording has started.');
      break;
    case 'bot.stopped': {
      state.botStopped = true;
      const reason = payload.bot_status ?? 'Stopped';
      if (reason === 'Stopped') log.info('Bot left the meeting.');
      else log.warn(`Bot stopped: ${reason} - ${payload.message ?? ''}`);
      state.waiter.wake();
      break;
    }
    case 'audio.processed':
      log.info('audio.processed received - per-participant splitting may still be running.');
      state.audioReady = true;
      state.waiter.wake();
      break;
    case 'bot.error':
      log.warn(`bot.error (non-terminal): ${payload.message ?? ''}`);
      break;
    default:
      log.debug(`Event: ${event}`);
  }
}

/**
 * Block until the bot reaches a terminal state (or the cap is hit).
 *
 * @param {object} params
 * @param {MeetStreamClient} params.client
 * @param {string} params.botId
 * @param {number} params.maxAttempts
 * @param {number} params.intervalMs
 */
async function waitForMeetingToEnd({ client, botId, maxAttempts, intervalMs }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (state.botStopped || state.audioReady) {
      log.info('Meeting has ended.');
      return;
    }
    try {
      const { status, terminal } = interpretBotStatus(await client.getBotStatus(botId));
      log.info(`[meeting ${attempt}/${maxAttempts}] Bot status: ${status}`);
      if (terminal) {
        state.botStopped = true;
        return;
      }
    } catch (err) {
      log.debug(`Status check failed: ${err.message}`);
    }
    await state.waiter.wait(intervalMs);
  }
  log.warn('Meeting wait cap reached - trying the streams endpoint anyway.');
}

/**
 * Poll get_audio_streams, treating 202 as "not done yet" and stopping at the cap.
 *
 * @param {object} params
 * @param {MeetStreamClient} params.client
 * @param {string} params.botId
 * @param {number} params.maxAttempts
 * @param {number} params.intervalMs
 * @returns {Promise<{ ready: boolean, status: number, data: any, message: string }>}
 */
async function pollAudioStreams({ client, botId, maxAttempts, intervalMs }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await fetchAudioStreams(client, botId);

    if (result.ready) {
      log.info(`Per-participant audio ready (HTTP ${result.status}).`);
      return result;
    }

    log.info(
      `[streams ${attempt}/${maxAttempts}] HTTP ${result.status} - ${result.message || 'still processing'}`
    );

    if (attempt === maxAttempts) break;
    await state.waiter.wait(intervalMs);
  }

  throw new Error(
    `get_audio_streams never returned 200 after ${maxAttempts} attempts ` +
      `(~${Math.round((maxAttempts * intervalMs) / 60000)} min). ` +
      'A bot using a streaming-only transcription provider returns 202 forever - it produces no ' +
      'post-call per-participant audio. Otherwise raise STREAMS_POLL_MAX_ATTEMPTS.'
  );
}

/**
 * @param {number} code
 */
async function shutdown(code) {
  if (state.server) {
    await new Promise((resolve) => state.server.close(resolve));
  }
  process.exit(code);
}

let sigintCount = 0;
process.on('SIGINT', async () => {
  sigintCount += 1;
  if (sigintCount > 1) {
    log.warn('Second Ctrl+C - exiting immediately.');
    process.exit(130);
  }
  log.info('Ctrl+C - asking the bot to leave, then downloading whatever is ready.');
  if (state.botId && state.client && !state.removeRequested) {
    state.removeRequested = true;
    try {
      const { alreadyGone } = await state.client.removeBot(state.botId);
      if (alreadyGone) state.botStopped = true;
    } catch (err) {
      log.warn(`remove_bot failed: ${err.message}`);
    }
  }
  state.botStopped = true;
  state.waiter.wake();
});

main().catch(async (err) => {
  log.error(err.message);
  await shutdown(1);
});
