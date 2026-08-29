/**
 * Decide which bot to work with.
 *
 * Two modes, chosen by which environment variables are set:
 *
 *   BOT_ID set        -> analyse a bot that already ran. Nothing is created.
 *   MEETING_LINK set  -> create a fresh bot, wait for it to finish, then analyse it.
 *
 * Setting BOT_ID always wins, so you can re-run the analysis part of a
 * template as many times as you like without joining the meeting again.
 */

import { envInt, TERMINAL_STATUSES } from './client.js';

/**
 * Build the create_bot payload.
 *
 * Only fields that exist in the MeetStream API are used here:
 *   meeting_link, bot_name, video_required, recording_config, automatic_leave.
 *
 * A *post-call* transcript provider is configured on purpose. Post-call
 * providers are what produce transcripts, summaries and a `bot.done`
 * lifecycle event; streaming-only providers (`*_streaming`,
 * `meeting_captions`) stop at `audio.processed` and never produce them.
 */
export function buildCreateBotPayload({ meetingLink, botName, extra = {} }) {
  const recordingConfig = {
    transcript: {
      provider: {
        deepgram: {
          model: 'nova-3',
          language: process.env.TRANSCRIPT_LANGUAGE || 'en',
          diarize: true,
          punctuate: true,
          smart_format: true,
        },
      },
    },
    retention: {
      type: 'timed',
      hours: envInt('RETENTION_HOURS', 72),
    },
    ...(extra.recording_config || {}),
  };

  return {
    meeting_link: meetingLink,
    bot_name: botName,
    video_required: false,
    recording_config: recordingConfig,
    automatic_leave: {
      waiting_room_timeout: envInt('WAITING_ROOM_TIMEOUT', 600),
      everyone_left_timeout: envInt('EVERYONE_LEFT_TIMEOUT', 600),
      // The API rejects anything below 600 with HTTP 400.
      in_call_recording_timeout: envInt('IN_CALL_RECORDING_TIMEOUT', 14_400),
    },
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'recording_config')),
  };
}

/**
 * Resolve the bot to analyse, creating and waiting on one if needed.
 *
 * @param {import('./client.js').MeetStreamClient} client
 * @param {{ botNameDefault?: string, extraCreateFields?: object }} [opts]
 * @returns {Promise<{ botId: string, created: boolean, finalStatus: string|null }>}
 */
export async function resolveBot(client, { botNameDefault = 'MeetStream Labs Bot', extraCreateFields = {} } = {}) {
  const existing = (process.env.BOT_ID || '').trim();
  if (existing) {
    console.log(`Using existing bot ${existing} (BOT_ID is set, no new bot will be created).`);
    let finalStatus = null;
    try {
      const body = await client.getStatus(existing);
      finalStatus = typeof body?.status === 'string' ? body.status : null;
      console.log(`Current status: ${finalStatus ?? 'unknown'}`);
      if (finalStatus && !TERMINAL_STATUSES.has(finalStatus)) {
        console.log('This bot is still live. Post-call artifacts may be incomplete or return HTTP 202.');
      }
    } catch (err) {
      console.warn(`Could not read bot status: ${err.message}`);
    }
    return { botId: existing, created: false, finalStatus };
  }

  const meetingLink = (process.env.MEETING_LINK || '').trim();
  if (!meetingLink) {
    throw new Error(
      'Nothing to work with. Set one of:\n' +
        '  BOT_ID       - analyse a meeting a bot already recorded\n' +
        '  MEETING_LINK - send a new bot into a live meeting, wait for it to finish, then analyse\n' +
        'See .env.example.'
    );
  }

  const botName = process.env.BOT_NAME || botNameDefault;
  const payload = buildCreateBotPayload({ meetingLink, botName, extra: extraCreateFields });

  console.log(`Creating bot "${botName}" for ${meetingLink} ...`);
  const { replayed, data } = await client.createBot(payload, {
    idempotencyKey: process.env.IDEMPOTENCY_KEY || undefined,
  });
  const botId = data?.bot_id;
  if (!botId) {
    throw new Error(`create_bot did not return a bot_id. Raw response: ${JSON.stringify(data)}`);
  }
  console.log(
    `Bot created${replayed ? ' (idempotent replay - HTTP 507, treated as success)' : ''}: ${botId}`
  );
  if (data.transcript_id) console.log(`transcript_id: ${data.transcript_id}`);

  console.log('Waiting for the meeting to finish. Ctrl+C to stop waiting (the bot keeps running).');
  const { status, timedOut } = await client.waitForTerminalStatus(botId, {
    intervalMs: envInt('STATUS_POLL_INTERVAL_MS', 15_000),
    maxAttempts: envInt('STATUS_POLL_MAX_ATTEMPTS', 240),
    onTick: (s) => console.log(`  status: ${s ?? 'unknown'}`),
  });

  if (timedOut) {
    console.warn(
      `Gave up waiting after ${envInt('STATUS_POLL_MAX_ATTEMPTS', 240)} polls (last status: ${status ?? 'unknown'}). ` +
        'Continuing anyway - artifacts may not be ready.'
    );
  } else {
    console.log(`Bot reached terminal status: ${status}`);
    if (status === 'NotAllowed') console.log('  The bot timed out in the waiting room.');
    if (status === 'Denied') console.log('  The host denied the bot entry.');
    if (status === 'Error') console.log('  The bot errored. Check GET /bots/{id}/detail for the timeline.');
  }

  return { botId, created: true, finalStatus: status };
}
