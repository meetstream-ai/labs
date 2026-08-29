#!/usr/bin/env node
/**
 * MeetStream Labs - Microsoft Teams meeting bot.
 *
 *   node index.js            create a bot and follow it over webhooks
 *   node index.js listen     webhook receiver only (no bot created)
 *   node index.js check      validate config and print the request body, no API call
 *
 * Teams needs no platform setup - pass a Teams link and the bot joins.
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
import { classify } from './src/lifecycle.js';
import {
  WAITING_ROOM_MAX_TEAMS,
  WAITING_ROOM_MIN,
  buildAutomaticLeave,
  buildTranscriptProvider,
  createTeamsBot,
  isTeamsLink,
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
    joinAt: optionalEnv('JOIN_AT'),

    waitingRoomTimeout: intEnv('WAITING_ROOM_TIMEOUT', {
      min: WAITING_ROOM_MIN,
      max: WAITING_ROOM_MAX_TEAMS,
    }),
    noOneJoinedTimeout: intEnv('NO_ONE_JOINED_TIMEOUT', { min: 60, max: 1800 }),
    everyoneLeftTimeout: intEnv('EVERYONE_LEFT_TIMEOUT', { min: 60, max: 1800 }),
    voiceInactivityTimeout: intEnv('VOICE_INACTIVITY_TIMEOUT', { min: 60, max: 1800 }),
    inCallRecordingTimeout: intEnv('IN_CALL_RECORDING_TIMEOUT', { min: 600, max: 18_000 }),

    transcriptProvider: optionalEnv('TRANSCRIPT_PROVIDER'),
    transcriptLanguage: optionalEnv('TRANSCRIPT_LANGUAGE', 'en'),
    retentionHours: intEnv('RETENTION_HOURS', { min: 1, max: 8760 }),
  };
}

function buildRecordingConfig(config) {
  const recordingConfig = {};
  const provider = buildTranscriptProvider(config.transcriptProvider, {
    language: config.transcriptLanguage,
  });
  if (provider) recordingConfig.transcript = { provider };
  if (config.retentionHours !== undefined) {
    recordingConfig.retention = { type: 'timed', hours: config.retentionHours };
  }
  return recordingConfig;
}

function buildOptions(config, callbackUrl) {
  if (!config.meetingLink) {
    throw new ConfigError('MEETING_LINK is required. Put your Teams meeting link in .env.');
  }
  if (!isTeamsLink(config.meetingLink)) {
    throw new ConfigError(
      `MEETING_LINK "${config.meetingLink}" does not look like a Microsoft Teams link.`
    );
  }
  if (config.joinAt && Number.isNaN(Date.parse(config.joinAt))) {
    throw new ConfigError(`JOIN_AT "${config.joinAt}" is not a valid ISO 8601 timestamp.`);
  }

  return {
    meetingLink: config.meetingLink,
    botName: config.botName,
    videoRequired: config.videoRequired,
    callbackUrl,
    joinAt: config.joinAt,
    automaticLeave: buildAutomaticLeave({
      waitingRoomTimeout: config.waitingRoomTimeout,
      noOneJoinedTimeout: config.noOneJoinedTimeout,
      everyoneLeftTimeout: config.everyoneLeftTimeout,
      voiceInactivityTimeout: config.voiceInactivityTimeout,
      inCallRecordingTimeout: config.inCallRecordingTimeout,
    }),
    recordingConfig: buildRecordingConfig(config),
  };
}

function cmdCheck(config) {
  const callbackUrl = config.publicUrl
    ? new URL(config.webhookPath, config.publicUrl).toString()
    : undefined;
  const opts = buildOptions(config, callbackUrl);

  const preview = {
    meeting_link: opts.meetingLink,
    bot_name: opts.botName,
    video_required: opts.videoRequired,
    ...(callbackUrl ? { callback_url: callbackUrl } : {}),
    ...(opts.joinAt ? { join_at: opts.joinAt } : {}),
    ...(Object.keys(opts.automaticLeave).length ? { automatic_leave: opts.automaticLeave } : {}),
    ...(Object.keys(opts.recordingConfig).length ? { recording_config: opts.recordingConfig } : {}),
  };

  console.log('Config is valid. This is the body that would be POSTed to /bots/create_bot:\n');
  console.log(JSON.stringify(preview, null, 2));

  if (config.transcriptProvider === 'meeting_captions') {
    console.log(
      '\nNote: meeting_captions uses Teams\' own native captions, so the create response returns ' +
        'transcript_id: null.'
    );
  }
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
  const opts = buildOptions(config, callbackUrl);

  const client = createClient();
  const notifier = createNotifier({ webhookUrl: config.notifyWebhookUrl });

  let botId = null;
  let joinedAt = null;
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

      if (info.admitted) joinedAt = Date.now();

      if (info.recording && joinedAt) {
        const gap = ((Date.now() - joinedAt) / 1000).toFixed(1);
        console.log(`     recording started ${gap}s after bot.inmeeting`);
      }

      if (info.terminal) {
        const level = info.outcome === 'Stopped' ? 'info' : 'error';
        await notifier[level](`Bot finished: ${info.outcome}`, {
          bot_id: info.botId,
          note: info.note,
        });
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

  process.on('SIGINT', () => {
    if (shuttingDown) return;
    shuttingDown = true;
    close().finally(() => process.exit(0));
  });

  try {
    const { bot, replayed, request } = await createTeamsBot(client, opts);
    botId = bot?.bot_id ?? null;

    console.log('Request:');
    console.log(JSON.stringify(request, null, 2));
    console.log(replayed ? '\nIdempotent replay (507).' : '\nBot created.');
    console.log(`  bot_id        ${bot?.bot_id ?? '-'}`);
    console.log(
      `  transcript_id ${
        bot?.transcript_id ??
        '(null - expected when using meeting_captions or no post-call provider)'
      }`
    );
    console.log(`  status        ${bot?.status ?? '-'}\n`);
  } catch (error) {
    await notifier.error('Could not create the Teams bot', { error: error.message });
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
        'HTTP 400 usually means an out-of-range automatic_leave value (waiting_room_timeout ' +
          '60-1800 on Teams, in_call_recording_timeout at least 600) or a malformed meeting link.'
      );
    }
  } else {
    console.error(`\n${error.stack ?? error.message}`);
  }
  process.exitCode = 1;
});
