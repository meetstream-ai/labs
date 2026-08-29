import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { MeetStreamClient, interpretBotStatus } from './src/client.js';
import { log } from './src/log.js';
import {
  downloadScreenshots,
  dumpRaw,
  extractScreenshots,
  fetchScreenshots,
  fetchSpeakerTimeline,
  writeTimelineReport,
} from './src/screenshots.js';
import { envInt, optionalEnv, requireEnv, sleep, timestampSlug } from './src/util.js';

/**
 * screenshot-capture
 *
 * Downloads a meeting's screenshots from `GET /bots/{bot_id}/get_screenshots`
 * and writes a report placing each one on the meeting timeline, cross-
 * referenced against `GET /bots/{bot_id}/get_speaker_timeline`.
 *
 * Two modes:
 *   - BOT_ID set   -> fetch screenshots from that (already finished) bot.
 *   - MEETING_LINK -> create a bot, wait for the meeting to end, then fetch.
 *
 * This template is poll-only: it needs no public URL and no webhook server.
 */

const state = {
  client: null,
  botId: null,
  createdBot: false,
  removeRequested: false,
  stopWaiting: false,
};

async function main() {
  const apiKey = requireEnv('MEETSTREAM_API_KEY');
  const existingBotId = optionalEnv('BOT_ID');
  const meetingLink = optionalEnv('MEETING_LINK');
  const botName = optionalEnv('BOT_NAME', 'MeetStream Screenshot Bot');
  const outputRoot = path.resolve(optionalEnv('OUTPUT_DIR', './screenshots-out'));
  const meetingMaxAttempts = envInt('MEETING_POLL_MAX_ATTEMPTS', 240);
  const meetingIntervalMs = envInt('MEETING_POLL_INTERVAL_MS', 15_000);
  const shotsMaxAttempts = envInt('SCREENSHOT_POLL_MAX_ATTEMPTS', 30);
  const shotsIntervalMs = envInt('SCREENSHOT_POLL_INTERVAL_MS', 10_000);
  const everyoneLeftTimeout = envInt('EVERYONE_LEFT_TIMEOUT', 60);

  if (!existingBotId && !meetingLink) {
    throw new Error('Set either BOT_ID (fetch from a finished bot) or MEETING_LINK (create a new bot).');
  }

  const client = new MeetStreamClient({
    apiKey,
    timeoutMs: envInt('REQUEST_TIMEOUT_MS', 30_000),
    maxRetries: envInt('MAX_RETRIES', 4),
  });
  state.client = client;

  let botId = existingBotId;

  if (botId) {
    log.info(`Fetching screenshots for existing bot ${botId}.`);
  } else {
    const payload = {
      meeting_link: meetingLink,
      bot_name: botName,
      video_required: true,
      automatic_leave: { everyone_left_timeout: everyoneLeftTimeout },
    };

    log.info(`Creating bot for ${meetingLink} ...`);
    const bot = await client.createBot(payload, { idempotencyKey: randomUUID() });
    botId = bot.bot_id;
    state.botId = botId;
    state.createdBot = true;
    log.info(`Bot created: bot_id=${botId} status=${bot.status ?? 'unknown'}`);
    log.info('Press Ctrl+C to pull the bot out of the meeting and collect screenshots early.');

    await waitForMeetingToEnd({ client, botId, maxAttempts: meetingMaxAttempts, intervalMs: meetingIntervalMs });
  }

  state.botId = botId;

  const destDir = path.join(outputRoot, `${timestampSlug()}_${botId}`);

  const screenshots = await pollScreenshots({
    client,
    botId,
    maxAttempts: shotsMaxAttempts,
    intervalMs: shotsIntervalMs,
  });

  const rawShotsPath = await dumpRaw(destDir, 'raw_get_screenshots_response.json', screenshots.data);
  log.debug(`Raw get_screenshots body saved to ${rawShotsPath}`);

  const shots = extractScreenshots(screenshots.data);
  if (shots.length === 0) {
    log.warn(`No screenshot URLs were returned. Inspect ${rawShotsPath}.`);
    process.exit(0);
  }

  log.info(`${shots.length} screenshot(s) available. Downloading...`);
  const results = await downloadScreenshots({ shots, destDir });

  const speakerTimelineData = await fetchSpeakerTimeline(client, botId);
  if (speakerTimelineData) {
    await dumpRaw(destDir, 'raw_get_speaker_timeline_response.json', speakerTimelineData);
  }

  const { markdownPath, jsonPath } = await writeTimelineReport({
    botId,
    destDir,
    results,
    speakerTimelineData,
  });

  const failed = results.filter((row) => row.error).length;
  log.info(`Saved ${results.length - failed}/${results.length} screenshot(s) to ${destDir}`);
  log.info(`Timeline report: ${markdownPath}`);
  log.info(`Machine-readable timeline: ${jsonPath}`);

  process.exit(failed > 0 ? 1 : 0);
}

/**
 * @param {object} params
 * @param {MeetStreamClient} params.client
 * @param {string} params.botId
 * @param {number} params.maxAttempts
 * @param {number} params.intervalMs
 */
async function waitForMeetingToEnd({ client, botId, maxAttempts, intervalMs }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (state.stopWaiting) {
      log.info('Stopping the wait early (Ctrl+C).');
      return;
    }
    try {
      const { status, terminal } = interpretBotStatus(await client.getBotStatus(botId));
      log.info(`[meeting ${attempt}/${maxAttempts}] Bot status: ${status}`);
      if (terminal) return;
    } catch (err) {
      log.debug(`Status check failed: ${err.message}`);
    }
    await sleep(intervalMs);
  }
  log.warn('Meeting wait cap reached - trying the screenshots endpoint anyway.');
}

/**
 * Poll get_screenshots, treating 202/404 as "not ready yet" and stopping at the cap.
 *
 * @param {object} params
 * @param {MeetStreamClient} params.client
 * @param {string} params.botId
 * @param {number} params.maxAttempts
 * @param {number} params.intervalMs
 */
async function pollScreenshots({ client, botId, maxAttempts, intervalMs }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await fetchScreenshots(client, botId);
    if (result.ready) return result;

    log.info(
      `[screenshots ${attempt}/${maxAttempts}] HTTP ${result.status} - ${result.message || 'still processing'}`
    );
    if (attempt === maxAttempts) break;
    await sleep(intervalMs);
  }

  throw new Error(
    `get_screenshots never returned 200 after ${maxAttempts} attempts. ` +
      'Screenshots are only produced for bots that captured video - confirm the bot recorded ' +
      'the meeting, or raise SCREENSHOT_POLL_MAX_ATTEMPTS.'
  );
}

let sigintCount = 0;
process.on('SIGINT', async () => {
  sigintCount += 1;
  if (sigintCount > 1) {
    log.warn('Second Ctrl+C - exiting immediately.');
    process.exit(130);
  }
  state.stopWaiting = true;
  if (state.createdBot && state.botId && state.client && !state.removeRequested) {
    state.removeRequested = true;
    log.info('Ctrl+C - asking the bot to leave, then collecting screenshots.');
    log.info('(Press Ctrl+C again to quit immediately.)');
    try {
      await state.client.removeBot(state.botId);
    } catch (err) {
      log.warn(`remove_bot failed: ${err.message}`);
    }
  } else {
    log.warn('Ctrl+C - exiting.');
    process.exit(130);
  }
});

main().catch((err) => {
  log.error(err.message);
  process.exit(1);
});
