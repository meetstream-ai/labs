import { randomUUID } from 'node:crypto';

import { assertBucketAccess, createS3Client, listBotObjects, printObjects } from './bucket.js';
import { DEFAULT_BASE_URL, interpretBotStatus, MeetStreamClient } from './client.js';
import { buildStorageConfig, CONFIG_TYPE, DEFAULT_PREFIX, KEY_NAME, redactConfig } from './config.js';
import { log } from './log.js';
import { createWaiter, envBool, envInt, optionalEnv, requireEnv } from './util.js';
import { createWebhookApp, listen } from './webhook.js';

/**
 * The four commands.
 *
 * set / show / delete manage the account-level storage config. `record` proves
 * the config works by running a real bot and then looking in the bucket.
 */

/** Build the MeetStream client from the environment. */
function makeClient() {
  return new MeetStreamClient({
    apiKey: requireEnv('MEETSTREAM_API_KEY'),
    baseUrl: optionalEnv('MEETSTREAM_API_BASE_URL', DEFAULT_BASE_URL),
    timeoutMs: envInt('REQUEST_TIMEOUT_MS', 30_000),
    maxRetries: envInt('MAX_RETRIES', 4),
  });
}

/** Build a local S3 client from the same credentials MeetStream is given. */
function makeS3Client(region) {
  return createS3Client({
    region,
    endpoint: optionalEnv('S3_ENDPOINT_URL'),
    forcePathStyle: envBool('S3_FORCE_PATH_STYLE', false),
    accessKeyId: optionalEnv('S3_ACCESS_KEY_ID'),
    secretAccessKey: optionalEnv('S3_SECRET_KEY'),
  });
}

/**
 * set - the main event.
 *
 *   1. Build the StorageConfigRequest from the environment
 *   2. Locally HeadBucket, so a typo fails here instead of inside MeetStream
 *   3. PUT /admin/configs?config_type=storage
 *   4. GET /admin/configs to read back what was saved
 *
 * From this point MeetStream writes bot media straight into your bucket. It
 * does not move anything that was already recorded.
 */
export async function commandSet(options) {
  const { config, prefixes } = buildStorageConfig();
  const safe = redactConfig(config);

  log.info(`Storage config for PUT /admin/configs?config_type=${CONFIG_TYPE}:`);
  log.info(JSON.stringify(safe, null, 2));

  if (options.flags.dryRun) {
    log.info('--dry-run, so nothing was sent.');
    return;
  }

  if (!options.flags.skipPreflight) {
    const s3 = makeS3Client(config.region);
    await assertBucketAccess(s3, config.bucket_name);
  } else {
    log.warn('--skip-preflight, so the local HeadBucket check was not run.');
  }

  const client = makeClient();

  log.warn('Sending S3 credentials to MeetStream. They are stored on your MeetStream account.');
  await client.setStorageConfig(config, CONFIG_TYPE);
  log.info('Storage config saved.');

  // Read it back rather than trusting the 200. The PUT response body is empty.
  const current = await client.getStorageConfig();

  if (options.json) {
    console.log(JSON.stringify(current, null, 2));
    return;
  }

  log.info('GET /admin/configs now returns:');
  log.info(JSON.stringify(current, null, 2));
  log.info(`Media will be keyed under: ${prefixes.map((p) => `${p}/<bot_id>_<file>`).join(', ')}`);
  log.info('Run "node index.js record" to send a bot in and confirm the files land.');
}

/** show - read the current config. Credential fields are never returned. */
export async function commandShow(options) {
  const client = makeClient();
  const current = await client.getStorageConfig();

  if (options.json) {
    console.log(JSON.stringify(current, null, 2));
    return;
  }

  log.info('GET /admin/configs:');
  log.info(JSON.stringify(current, null, 2));

  if (!current || (typeof current === 'object' && Object.keys(current).length === 0)) {
    log.warn('The response is empty, so no storage config is set. Bots write to the MeetStream platform bucket.');
  }
}

/** delete - remove the config and the stored credentials. */
export async function commandDelete(options) {
  const keyName = options.flags.keyName || KEY_NAME;

  if (!options.flags.yes) {
    throw new Error(
      `Refusing to delete the storage config without --yes. New bots would go back to writing ` +
        'into the MeetStream platform bucket. Files already in your bucket are not touched.'
    );
  }

  const client = makeClient();
  const result = await client.deleteStorageConfig(keyName);

  if (options.json) {
    console.log(JSON.stringify(result ?? {}, null, 2));
    return;
  }

  log.info(`Storage config deleted (key_name=${keyName}).`);
  log.info('New bots write to the MeetStream platform bucket again.');
  log.info('Files already written into your bucket are untouched. Delete them yourself if you want them gone.');
}

/**
 * record - end-to-end proof.
 *
 *   1. Confirm a storage config is set
 *   2. Create a bot
 *   3. Wait for it to leave and for post-processing to finish
 *   4. List `<prefix>/<bot_id>_*` in your bucket
 *
 * Step 4 matters most in write_only mode, where MeetStream's own fetch
 * endpoints return 403 for media that lives in your bucket, so the bucket is
 * the only place the recording can be seen.
 */
export async function commandRecord(options) {
  const meetingLink = requireEnv('MEETING_LINK');
  const bucket = requireEnv('S3_BUCKET');
  const region = requireEnv('S3_REGION');

  const botName = optionalEnv('BOT_NAME', 'MeetStream BYOB Recorder');
  const publicWebhookUrl = optionalEnv('PUBLIC_WEBHOOK_URL');
  const port = envInt('PORT', 3000);
  const wantVideo = envBool('VIDEO_REQUIRED', true);
  const everyoneLeftTimeout = envInt('EVERYONE_LEFT_TIMEOUT', 60);
  const maxAttempts = envInt('POLL_MAX_ATTEMPTS', 80);
  const intervalMs = envInt('POLL_INTERVAL_MS', 15_000);

  const basePrefix = optionalEnv('S3_PREFIX', DEFAULT_PREFIX) ?? DEFAULT_PREFIX;
  const prefixes = [
    ...new Set(
      [
        basePrefix.replace(/^\/+|\/+$/g, ''),
        optionalEnv('S3_PREFIX_AUDIO'),
        optionalEnv('S3_PREFIX_VIDEO'),
        optionalEnv('S3_PREFIX_TRANSCRIPT'),
        optionalEnv('S3_PREFIX_METADATA'),
      ]
        .filter(Boolean)
        .map((value) => value.replace(/^\/+|\/+$/g, ''))
    ),
  ];

  const client = makeClient();

  // 1. A bot with no storage config just writes to MeetStream's bucket, and the
  //    verification step at the end would look for objects that never appear.
  const current = await client.getStorageConfig();
  if (!current || (typeof current === 'object' && Object.keys(current).length === 0)) {
    log.warn('GET /admin/configs came back empty. Run "node index.js set" first, or this bot');
    log.warn('will write to the MeetStream platform bucket and nothing will land in yours.');
  } else {
    log.info(`Storage config in place: ${JSON.stringify(current)}`);
  }

  const state = {
    botId: null,
    client,
    server: null,
    botStopped: false,
    mediaProcessed: false,
    removeRequested: false,
    waiter: createWaiter(),
  };

  let callbackUrl;
  if (publicWebhookUrl) {
    const app = createWebhookApp({ onEvent: (event, payload) => handleEvent(state, event, payload) });
    state.server = await listen({ app, port });
    callbackUrl = `${publicWebhookUrl.replace(/\/+$/, '')}/webhook`;
    log.info(`Webhook server listening on port ${port}, public URL ${callbackUrl}`);
  } else {
    log.warn('PUBLIC_WEBHOOK_URL is not set - running in poll-only mode (no webhooks).');
  }

  /** @type {Record<string, any>} */
  const payload = {
    meeting_link: meetingLink,
    bot_name: botName,
    video_required: wantVideo,
    automatic_leave: { everyone_left_timeout: everyoneLeftTimeout },
  };
  if (callbackUrl) payload.callback_url = callbackUrl;

  installSigintHandler(state);

  try {
    log.info(`Creating bot for ${meetingLink} ...`);
    const bot = await client.createBot(payload, { idempotencyKey: randomUUID() });
    state.botId = bot.bot_id;
    log.info(`Bot created: bot_id=${bot.bot_id} status=${bot.status ?? 'unknown'}`);
    log.info(`Expecting objects under s3://${bucket}/<prefix>/${bot.bot_id}_*`);
    log.info('Press Ctrl+C to pull the bot out of the meeting early.');

    // 2. Wait for the bot to leave the meeting.
    await waitForBotToFinish(state, { maxAttempts, intervalMs });

    if (options.flags.skipVerify) {
      log.info('--skip-verify, so the bucket was not listed.');
      log.info(`Check s3://${bucket}/${prefixes[0]}/${bot.bot_id}_* yourself once processing completes.`);
      return;
    }

    // 3. Post-processing runs after the bot leaves, so poll the bucket.
    const s3 = makeS3Client(region);
    const objects = await waitForObjects(state, {
      s3,
      bucket,
      prefixes,
      botId: bot.bot_id,
      maxAttempts,
      intervalMs,
    });

    if (objects.length === 0) {
      log.error(`Nothing appeared under s3://${bucket}/<prefix>/${bot.bot_id}_ within the poll budget.`);
      log.error('Check GET /admin/configs, and see the troubleshooting section of the README.');
      process.exitCode = 1;
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(objects, null, 2));
      return;
    }

    log.info(`MeetStream wrote ${objects.length} object${objects.length === 1 ? '' : 's'} into your bucket:`);
    printObjects(bucket, objects);
  } finally {
    if (state.server) await new Promise((resolve) => state.server.close(resolve));
  }
}

/**
 * Webhook events worth reacting to. `bot.stopped` is terminal regardless of the
 * reason it reports, and always carries status_code 200.
 *
 * @param {any} state
 * @param {string} event
 * @param {any} payload
 */
function handleEvent(state, event, payload) {
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
    case 'video.processed':
      log.info(`${event} received.`);
      state.mediaProcessed = true;
      state.waiter.wake();
      break;
    case 'bot.done':
      log.info('bot.done received - post-processing is complete.');
      state.mediaProcessed = true;
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
 * Poll GET /bots/{id}/status until the bot reaches a terminal state, or a
 * webhook tells us it already did.
 *
 * @param {any} state
 * @param {{ maxAttempts: number, intervalMs: number }} opts
 */
async function waitForBotToFinish(state, { maxAttempts, intervalMs }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (state.botStopped) return;

    try {
      const { status, terminal } = interpretBotStatus(await state.client.getBotStatus(state.botId));
      log.info(`[bot ${attempt}/${maxAttempts}] status: ${status}`);
      if (terminal) {
        state.botStopped = true;
        return;
      }
    } catch (err) {
      log.debug(`Status check failed: ${err.message}`);
    }

    await state.waiter.wait(intervalMs);
  }

  log.warn(`The bot was still running after ${maxAttempts} status checks. Moving on to the bucket check anyway.`);
}

/**
 * Poll the bucket until the bot's objects show up, capped.
 *
 * @param {any} state
 * @param {object} params
 * @returns {Promise<Array<{key: string, size: number}>>}
 */
async function waitForObjects(state, { s3, bucket, prefixes, botId, maxAttempts, intervalMs }) {
  log.info(`Listing s3://${bucket}/<prefix>/${botId}_* every ${Math.round(intervalMs / 1000)}s ...`);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let objects = [];
    try {
      objects = await listBotObjects({ s3, bucket, prefixes, botId });
    } catch (err) {
      // A listing failure is a local permissions problem, not a MeetStream one.
      throw new Error(
        `Could not list s3://${bucket}: ${err.message}. ` +
          'The local credentials need s3:ListBucket on the bucket ARN. See the README.'
      );
    }

    if (objects.length > 0) return objects;

    log.info(`[bucket ${attempt}/${maxAttempts}] nothing yet, media processing runs after the bot leaves.`);
    if (attempt === maxAttempts) break;
    await state.waiter.wait(intervalMs);
  }

  return [];
}

/** Ctrl+C pulls the bot out of the meeting instead of orphaning it. */
function installSigintHandler(state) {
  let sigintCount = 0;
  process.on('SIGINT', async () => {
    sigintCount += 1;
    if (sigintCount > 1) {
      log.warn('Second Ctrl+C - exiting immediately.');
      process.exit(130);
    }
    log.info('Ctrl+C - asking the bot to leave.');
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
}
