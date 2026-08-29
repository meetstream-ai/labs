import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { MeetStreamClient, interpretBotStatus } from './src/client.js';
import { log } from './src/log.js';
import { fetchRecording } from './src/media.js';
import { createWaiter, envInt, optionalEnv, requireEnv, timestampSlug } from './src/util.js';
import { createWebhookApp, listen } from './src/webhook.js';

/**
 * audio-recording-downloader
 *
 * 1. Creates a MeetStream bot that joins a meeting and records audio only.
 * 2. Waits for the `audio.processed` webhook (fast path).
 * 3. Calls GET /bots/{bot_id}/get_audio and streams the file to disk with a
 *    progress meter.
 *
 * Webhooks are best-effort, so a bounded poll loop runs alongside them and is
 * the actual guarantee that this program terminates. If you do not have a
 * public URL to receive webhooks on, leave PUBLIC_WEBHOOK_URL blank and the
 * poll loop alone will do the job.
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
  const botName = optionalEnv('BOT_NAME', 'MeetStream Audio Recorder');
  const publicWebhookUrl = optionalEnv('PUBLIC_WEBHOOK_URL');
  const port = envInt('PORT', 3000);
  const outputRoot = path.resolve(optionalEnv('OUTPUT_DIR', './recordings'));
  const maxAttempts = envInt('POLL_MAX_ATTEMPTS', 80);
  const intervalMs = envInt('POLL_INTERVAL_MS', 15_000);
  const retentionHours = envInt('RETENTION_HOURS', 0);
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

  /**
   * Only real create_bot fields are used here.
   * `video_required: false` keeps this an audio-only recording.
   */
  const payload = {
    meeting_link: meetingLink,
    bot_name: botName,
    video_required: false,
    automatic_leave: {
      everyone_left_timeout: everyoneLeftTimeout,
    },
  };
  if (callbackUrl) payload.callback_url = callbackUrl;
  if (retentionHours > 0) {
    payload.recording_config = { retention: { type: 'timed', hours: retentionHours } };
  }

  log.info(`Creating bot for ${meetingLink} ...`);
  const bot = await client.createBot(payload, { idempotencyKey: randomUUID() });
  state.botId = bot.bot_id;
  log.info(`Bot created: bot_id=${bot.bot_id} status=${bot.status ?? 'unknown'}`);

  const destDir = path.join(outputRoot, `${timestampSlug()}_${bot.bot_id}`);
  log.info(`Audio will be saved under ${destDir}`);
  log.info('Press Ctrl+C to pull the bot out of the meeting and download whatever is ready.');

  const result = await waitForRecording({ client, botId: bot.bot_id, destDir, maxAttempts, intervalMs });

  for (const file of result.files) {
    log.info(`Saved ${file.path} (${file.bytes} bytes)`);
  }
  await shutdown(0);
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
      // bot.stopped is always status_code 200; bot_status carries the reason.
      if (reason === 'Stopped') log.info('Bot left the meeting.');
      else log.warn(`Bot stopped: ${reason} - ${payload.message ?? ''}`);
      state.waiter.wake();
      break;
    }
    case 'audio.processed':
      log.info('audio.processed received - the recording is ready.');
      state.audioReady = true;
      state.waiter.wake();
      break;
    case 'bot.error':
      // Non-terminal: a streaming provider hiccuped, the bot keeps running.
      log.warn(`bot.error (non-terminal): ${payload.message ?? ''}`);
      break;
    default:
      log.debug(`Event: ${event}`);
  }
}

/**
 * Poll until the audio recording can actually be downloaded, then download it.
 *
 * @param {object} params
 * @param {MeetStreamClient} params.client
 * @param {string} params.botId
 * @param {string} params.destDir
 * @param {number} params.maxAttempts
 * @param {number} params.intervalMs
 */
async function waitForRecording({ client, botId, destDir, maxAttempts, intervalMs }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (!state.botStopped && !state.audioReady) {
      try {
        const { status, terminal } = interpretBotStatus(await client.getBotStatus(botId));
        log.info(`[${attempt}/${maxAttempts}] Bot status: ${status}`);
        if (terminal) state.botStopped = true;
      } catch (err) {
        log.debug(`Status check failed: ${err.message}`);
      }
    }

    if (state.audioReady || state.botStopped) {
      const result = await fetchRecording({ client, botId, kind: 'audio', destDir });
      if (result.ready) return result;
      log.info(`[${attempt}/${maxAttempts}] ${result.reason}`);
    } else {
      log.debug(`[${attempt}/${maxAttempts}] Meeting still running - waiting for it to end.`);
    }

    if (attempt === maxAttempts) break;
    await state.waiter.wait(intervalMs);
  }

  throw new Error(
    `Gave up after ${maxAttempts} attempts (~${Math.round((maxAttempts * intervalMs) / 60000)} min). ` +
      'The recording never became downloadable. Raise POLL_MAX_ATTEMPTS or check the bot in the MeetStream dashboard.'
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
  state.waiter.wake();
});

main().catch(async (err) => {
  log.error(err.message);
  await shutdown(1);
});
