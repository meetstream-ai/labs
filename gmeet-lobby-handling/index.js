#!/usr/bin/env node
/**
 * MeetStream Labs - Google Meet lobby / waiting room handling.
 *
 * Starts a webhook receiver, sends a bot into a Google Meet with a tuned
 * `automatic_leave.waiting_room_timeout`, then reacts to how the admission goes:
 *
 *   still waiting too long  -> nudge a human who can admit it
 *   NotAllowed (timed out)  -> retry with a longer wait
 *   Denied (host said no)   -> stop and notify, never retry
 *
 *   node index.js            run the full flow
 *   node index.js listen     webhook receiver only (no bot created)
 */

import 'dotenv/config';
import process from 'node:process';

import {
  ConfigError,
  MeetStreamError,
  boolEnv,
  createClient,
  intEnv,
  optionalEnv,
  requireEnv,
} from './src/client.js';
import { startWebhookServer } from './src/server.js';
import { createNotifier } from './src/notify.js';
import { classify } from './src/outcomes.js';
import { JoinManager } from './src/join-manager.js';
import { WAITING_ROOM_MAX_GMEET, WAITING_ROOM_MIN, assertWaitingRoomTimeout } from './src/bot.js';

function readConfig() {
  const port = intEnv('PORT', { fallback: 3000, min: 1, max: 65_535 });
  const webhookPath = optionalEnv('WEBHOOK_PATH', '/webhook');
  const publicUrl = optionalEnv('PUBLIC_WEBHOOK_URL');

  const waitingRoomTimeout = intEnv('WAITING_ROOM_TIMEOUT', {
    fallback: 300,
    min: WAITING_ROOM_MIN,
    max: WAITING_ROOM_MAX_GMEET,
  });
  assertWaitingRoomTimeout(waitingRoomTimeout);

  return {
    port,
    webhookPath,
    publicUrl,
    webhookSecret: optionalEnv('WEBHOOK_SECRET'),
    notifyWebhookUrl: optionalEnv('NOTIFY_WEBHOOK_URL'),
    meetingLink: optionalEnv('MEETING_LINK'),
    botName: optionalEnv('BOT_NAME', 'MeetStream Notetaker'),
    videoRequired: boolEnv('VIDEO_REQUIRED', false),
    waitingRoomTimeout,
    lobbyAlertSeconds: intEnv('LOBBY_ALERT_SECONDS', { fallback: 60, min: 0, max: 600 }),
    maxAttempts: intEnv('MAX_JOIN_ATTEMPTS', { fallback: 2, min: 1, max: 5 }),
    retryDelaySeconds: intEnv('RETRY_DELAY_SECONDS', { fallback: 30, min: 0, max: 3600 }),
    timeoutEscalation: intEnv('RETRY_TIMEOUT_ESCALATION', { fallback: 120, min: 0, max: 540 }),
    signedInDomain: optionalEnv('GOOGLE_LOGIN_DOMAIN'),
    signInEmail: optionalEnv('SIGN_IN_EMAIL'),
    strictEmail: boolEnv('STRICT_EMAIL', false),
  };
}

async function runListenOnly(config) {
  const { close } = await startWebhookServer({
    port: config.port,
    path: config.webhookPath,
    secret: config.webhookSecret,
    onEvent: (payload) => {
      const info = classify(payload);
      console.log(
        `${new Date().toISOString()}  ${info.event ?? '?'}  bot_status=${info.status ?? '-'}  ` +
          `bot=${info.botId ?? '-'}${info.terminal ? `  TERMINAL (${info.outcome})` : ''}`
      );
      if (info.terminal) console.log(`    ${info.reason}`);
    },
  });

  console.log(
    `Listening for MeetStream webhooks on http://localhost:${config.port}${config.webhookPath}\n` +
      'Point a bot\'s callback_url here (expose it with ngrok or a Cloudflare tunnel) and watch.\n' +
      'Ctrl-C to stop.'
  );

  process.on('SIGINT', () => {
    close().finally(() => process.exit(0));
  });
}

async function run(config) {
  if (!config.meetingLink) {
    throw new ConfigError('MEETING_LINK is required. Put a meet.google.com link in your .env.');
  }
  if (!config.publicUrl) {
    throw new ConfigError(
      'PUBLIC_WEBHOOK_URL is required - MeetStream has to be able to reach your webhook from the ' +
        'internet. Run `ngrok http ' +
        config.port +
        '` (or a Cloudflare tunnel) and paste the https URL here.'
    );
  }

  // Fail before starting anything if the key is missing.
  requireEnv('MEETSTREAM_API_KEY', 'Create one at https://app.meetstream.ai.');

  const client = createClient();
  const notifier = createNotifier({ webhookUrl: config.notifyWebhookUrl });

  const callbackUrl = new URL(config.webhookPath, config.publicUrl).toString();

  let manager;
  let shuttingDown = false;

  const { close } = await startWebhookServer({
    port: config.port,
    path: config.webhookPath,
    secret: config.webhookSecret,
    onEvent: (payload) => manager?.handleEvent(payload),
  });

  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await close().catch(() => {});
    process.exit(code);
  };

  manager = new JoinManager({
    client,
    notifier,
    maxAttempts: config.maxAttempts,
    retryDelaySeconds: config.retryDelaySeconds,
    timeoutEscalation: config.timeoutEscalation,
    lobbyAlertSeconds: config.lobbyAlertSeconds,
    botOptions: {
      meetingLink: config.meetingLink,
      botName: config.botName,
      videoRequired: config.videoRequired,
      waitingRoomTimeout: config.waitingRoomTimeout,
      callbackUrl,
      signedIn: config.signedInDomain
        ? {
            domain: config.signedInDomain,
            email: config.signInEmail,
            strict: config.strictEmail,
          }
        : undefined,
    },
    onFinished: (summary) => {
      console.log(
        `\nRun finished: ${summary.outcome} after ${summary.attempts} attempt(s). Shutting down.`
      );
      const failed = ['Denied', 'NotAllowed', 'Error', 'RetryFailed'].includes(summary.outcome);
      shutdown(failed ? 1 : 0);
    },
  });

  console.log(`Webhook receiver on http://localhost:${config.port}${config.webhookPath}`);
  console.log(`Telling MeetStream to call back at ${callbackUrl}`);
  if (!config.webhookSecret) {
    console.log(
      'Signature verification is off. Per-bot callback_url deliveries are unsigned anyway - set\n' +
        'WEBHOOK_SECRET only if you are receiving on a dashboard workspace endpoint.'
    );
  }
  if (!config.signedInDomain) {
    console.log(
      'Joining anonymously. Set GOOGLE_LOGIN_DOMAIN to join signed in - an invited signed-in bot\n' +
        'skips the lobby entirely, which beats any retry policy.'
    );
  }
  console.log('');

  process.on('SIGINT', () => shutdown(0));

  try {
    await manager.start();
  } catch (error) {
    await notifier.error('Could not create the bot', { error: error.message });
    await shutdown(1);
  }
}

async function main() {
  const config = readConfig();
  if (process.argv[2] === 'listen') {
    await runListenOnly(config);
    return;
  }
  await run(config);
}

main().catch((error) => {
  if (error instanceof ConfigError) {
    console.error(`\nConfiguration error: ${error.message}`);
  } else if (error instanceof MeetStreamError) {
    console.error(`\n${error.message}`);
    if (error.status === 400) {
      console.error(
        'HTTP 400 usually means an out-of-range automatic_leave value. On Google Meet, ' +
          'waiting_room_timeout must be 60-600 seconds.'
      );
    }
  } else {
    console.error(`\n${error.stack ?? error.message}`);
  }
  process.exitCode = 1;
});
