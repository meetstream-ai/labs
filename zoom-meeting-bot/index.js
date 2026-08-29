#!/usr/bin/env node
/**
 * MeetStream Labs - Zoom meeting bot.
 *
 * Sends a bot into a Zoom meeting and walks the Zoom-specific recording
 * permission flow, which is the one thing Zoom does that Google Meet and
 * Microsoft Teams do not.
 *
 *   node index.js            create a bot and follow it over webhooks
 *   node index.js listen     webhook receiver only (no bot created)
 *   node index.js check      validate config and print the request body, no API call
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
import { POST_CALL_EVENTS, classify } from './src/events.js';
import {
  RECORDING_PERMISSION_TIMEOUT_MAX,
  RECORDING_PERMISSION_TIMEOUT_MIN,
  WAITING_ROOM_MAX_ZOOM,
  WAITING_ROOM_MIN,
  buildAutomaticLeave,
  createZoomBot,
  hasPasswordComponent,
  isZoomLink,
} from './src/bot.js';

function readConfig() {
  return {
    port: intEnv('PORT', { fallback: 3000, min: 1, max: 65_535 }),
    webhookPath: optionalEnv('WEBHOOK_PATH', '/webhook'),
    publicUrl: optionalEnv('PUBLIC_WEBHOOK_URL'),
    webhookSecret: optionalEnv('WEBHOOK_SECRET'),
    notifyWebhookUrl: optionalEnv('NOTIFY_WEBHOOK_URL'),

    meetingLink: optionalEnv('MEETING_LINK'),
    botName: optionalEnv('BOT_NAME', 'MeetStream Notetaker'),
    videoRequired: boolEnv('VIDEO_REQUIRED', false),

    recordingPermissionDeniedTimeout: intEnv('RECORDING_PERMISSION_DENIED_TIMEOUT', {
      fallback: 60,
      min: RECORDING_PERMISSION_TIMEOUT_MIN,
      max: RECORDING_PERMISSION_TIMEOUT_MAX,
    }),
    waitingRoomTimeout: intEnv('WAITING_ROOM_TIMEOUT', {
      min: WAITING_ROOM_MIN,
      max: WAITING_ROOM_MAX_ZOOM,
    }),
    everyoneLeftTimeout: intEnv('EVERYONE_LEFT_TIMEOUT', { min: 60, max: 1800 }),
    inCallRecordingTimeout: intEnv('IN_CALL_RECORDING_TIMEOUT', { min: 600, max: 18_000 }),

    obfUserId: optionalEnv('ZOOM_OAUTH_CONNECTION_USER_ID'),
    transcriptProvider: optionalEnv('TRANSCRIPT_PROVIDER'),
    transcriptLanguage: optionalEnv('TRANSCRIPT_LANGUAGE', 'en'),
    retentionHours: intEnv('RETENTION_HOURS', { min: 1, max: 8760 }),
  };
}

function buildRecordingConfig(config) {
  const recordingConfig = {};

  if (config.transcriptProvider) {
    // Pick exactly ONE provider key under transcript.provider.
    // meeting_captions is not available on Zoom - use any other provider.
    if (config.transcriptProvider === 'meeting_captions') {
      throw new ConfigError(
        'meeting_captions is not available on Zoom. Use deepgram, assemblyai, sarvam, ' +
          'jigsawstack or meetstream instead.'
      );
    }
    const provider =
      config.transcriptProvider === 'deepgram'
        ? { deepgram: { model: 'nova-3', language: config.transcriptLanguage } }
        : { [config.transcriptProvider]: {} };
    recordingConfig.transcript = { provider };
  }

  if (config.retentionHours !== undefined) {
    recordingConfig.retention = { type: 'timed', hours: config.retentionHours };
  }

  return recordingConfig;
}

function buildRequest(config, callbackUrl) {
  if (!config.meetingLink) {
    throw new ConfigError('MEETING_LINK is required. Put your Zoom invite link in .env.');
  }
  if (!isZoomLink(config.meetingLink)) {
    throw new ConfigError(`MEETING_LINK "${config.meetingLink}" does not look like a Zoom link.`);
  }

  return {
    meetingLink: config.meetingLink,
    botName: config.botName,
    videoRequired: config.videoRequired,
    callbackUrl,
    automaticLeave: buildAutomaticLeave({
      recordingPermissionDeniedTimeout: config.recordingPermissionDeniedTimeout,
      waitingRoomTimeout: config.waitingRoomTimeout,
      everyoneLeftTimeout: config.everyoneLeftTimeout,
      inCallRecordingTimeout: config.inCallRecordingTimeout,
    }),
    recordingConfig: buildRecordingConfig(config),
    obf: config.obfUserId ? { userId: config.obfUserId } : undefined,
  };
}

function warnAboutLink(config) {
  if (!hasPasswordComponent(config.meetingLink)) {
    console.log(
      'Note: the link has no ?pwd= component. If the meeting is password protected, paste the\n' +
        '      full invite link including ?pwd= or the bot cannot get in.\n'
    );
  }
}

async function cmdCheck(config) {
  const callbackUrl = config.publicUrl
    ? new URL(config.webhookPath, config.publicUrl).toString()
    : undefined;

  const opts = buildRequest(config, callbackUrl);
  warnAboutLink(config);

  const preview = {
    meeting_link: opts.meetingLink,
    bot_name: opts.botName,
    video_required: opts.videoRequired,
    ...(callbackUrl ? { callback_url: callbackUrl } : {}),
    ...(Object.keys(opts.automaticLeave).length ? { automatic_leave: opts.automaticLeave } : {}),
    ...(Object.keys(opts.recordingConfig).length
      ? { recording_config: opts.recordingConfig }
      : {}),
    ...(opts.obf
      ? { zoom: { use_zoom_obf: true, zoom_oauth_connection_user_id: opts.obf.userId } }
      : {}),
  };

  console.log('Config is valid. This is the body that would be POSTed to /bots/create_bot:\n');
  console.log(JSON.stringify(preview, null, 2));
}

async function runListenOnly(config) {
  const { close } = await startWebhookServer({
    port: config.port,
    path: config.webhookPath,
    secret: config.webhookSecret,
    onEvent: (payload) => {
      const info = classify(payload);
      console.log(
        `${new Date().toISOString()}  ${info.event ?? '?'}  bot_status=${info.status ?? '-'}  bot=${
          info.botId ?? '-'
        }`
      );
      if (info.note) console.log(`    ${info.note}`);
    },
  });

  console.log(
    `Listening for MeetStream webhooks on http://localhost:${config.port}${config.webhookPath}\n` +
      'Ctrl-C to stop.'
  );
  process.on('SIGINT', () => close().finally(() => process.exit(0)));
}

async function run(config) {
  if (!config.publicUrl) {
    throw new ConfigError(
      'PUBLIC_WEBHOOK_URL is required - MeetStream must be able to reach your webhook. ' +
        `Run \`ngrok http ${config.port}\` and paste the https origin here.`
    );
  }
  requireEnv('MEETSTREAM_API_KEY', 'Create one at https://app.meetstream.ai.');

  const callbackUrl = new URL(config.webhookPath, config.publicUrl).toString();
  const opts = buildRequest(config, callbackUrl);

  const client = createClient();
  const notifier = createNotifier({ webhookUrl: config.notifyWebhookUrl });

  let botId = null;
  let permissionOutcome = null;
  let shuttingDown = false;

  const { close } = await startWebhookServer({
    port: config.port,
    path: config.webhookPath,
    secret: config.webhookSecret,
    onEvent: async (payload) => {
      const info = classify(payload);

      if (info.botId && botId && info.botId !== botId) return;

      console.log(
        `  <- ${info.event ?? 'unknown'}  bot_status=${info.status ?? '-'}` +
          (info.message ? `  "${info.message}"` : '')
      );
      if (info.note) console.log(`     ${info.note}`);

      if (info.permission === 'allowed' && permissionOutcome !== 'allowed') {
        permissionOutcome = 'allowed';
        await notifier.info('Zoom host granted recording permission', { bot_id: info.botId });
      }

      if (info.permission === 'denied' && permissionOutcome !== 'denied') {
        permissionOutcome = 'denied';
        await notifier.warn('Zoom recording permission was denied', {
          bot_id: info.botId,
          timeout_used: `${config.recordingPermissionDeniedTimeout}s`,
          what_happens_next:
            'The bot leaves cleanly (bot.leaving then bot.stopped). No recording is produced.',
          fixes:
            'Ask the host to grant the prompt, make the host a co-host of the bot account, or ' +
            'raise recording_permission_denied_timeout (max 300s) so a slow host still has time.',
        });
      }

      if (POST_CALL_EVENTS.has(info.event)) {
        console.log(`     post-call: ${info.event}`);
      }

      if (info.terminal) {
        await notifier.info(`Bot finished: ${info.outcome}`, {
          bot_id: info.botId,
          recording_permission: permissionOutcome ?? 'never requested',
          note: info.note,
        });

        if (info.event === 'bot.stopped' || info.event === 'bot.kicked') {
          console.log(
            '\nPost-call processing continues after the bot leaves. Keep listening for ' +
              'audio.processed / transcription.processed / bot.done.'
          );
        }
      }

      if (info.event === 'bot.done') {
        console.log('\nPipeline complete. Shutting down.');
        if (!shuttingDown) {
          shuttingDown = true;
          await close().catch(() => {});
          process.exit(0);
        }
      }
    },
  });

  console.log(`Webhook receiver on http://localhost:${config.port}${config.webhookPath}`);
  console.log(`callback_url: ${callbackUrl}\n`);
  warnAboutLink(config);

  process.on('SIGINT', () => {
    if (shuttingDown) return;
    shuttingDown = true;
    close().finally(() => process.exit(0));
  });

  try {
    const { bot, replayed, request } = await createZoomBot(client, opts);
    botId = bot?.bot_id ?? null;

    console.log('Request:');
    console.log(JSON.stringify(request, null, 2));
    console.log(replayed ? '\nIdempotent replay (507).' : '\nBot created.');
    console.log(`  bot_id        ${bot?.bot_id ?? '-'}`);
    console.log(`  transcript_id ${bot?.transcript_id ?? '(none - no post-call provider set)'}`);
    console.log(`  status        ${bot?.status ?? '-'}`);
    console.log(
      `\nZoom gates recording on host consent. After bot.inmeeting the bot asks, then waits up to ` +
        `${config.recordingPermissionDeniedTimeout}s for an answer.\n`
    );
  } catch (error) {
    await notifier.error('Could not create the Zoom bot', { error: error.message });
    await close().catch(() => {});
    throw error;
  }
}

async function main() {
  const config = readConfig();
  const command = process.argv[2];

  if (command === 'listen') return runListenOnly(config);
  if (command === 'check') return cmdCheck(config);
  return run(config);
}

main().catch((error) => {
  if (error instanceof ConfigError) {
    console.error(`\nConfiguration error: ${error.message}`);
  } else if (error instanceof MeetStreamError) {
    console.error(`\n${error.message}`);
    if (error.status === 400) {
      console.error(
        'HTTP 400 on Zoom usually means: an out-of-range automatic_leave value ' +
          '(recording_permission_denied_timeout must be 60-300, waiting_room_timeout 60-1200, ' +
          'in_call_recording_timeout at least 600), or a malformed meeting link.'
      );
    }
    if (error.status === 403) {
      console.error(
        'HTTP 403: check the API key. If the key is fine, your Zoom Marketplace app credentials ' +
          'may not be connected in Dashboard -> Integrations -> Zoom.'
      );
    }
  } else {
    console.error(`\n${error.stack ?? error.message}`);
  }
  process.exitCode = 1;
});
