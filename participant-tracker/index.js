#!/usr/bin/env node
/**
 * participant-tracker
 *
 * Tracks who joined and left a meeting, then builds an attendance report.
 *
 *   MEETING_LINK + PUBLIC_URL -> live mode: run a webhook server, send a bot
 *                                in, watch participant_events.join/.leave in
 *                                real time, report when the meeting ends.
 *   BOT_ID                    -> report mode: rebuild attendance for a meeting
 *                                that already happened. No server needed.
 *
 * Run: npm install && node index.js
 */

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { MeetStreamClient, MeetStreamError, envInt, readApiKey, sleep } from './src/client.js';
import { buildCreateBotPayload } from './src/session.js';
import { AttendanceTracker, trackerFromStoredEvents } from './src/tracker.js';
import { startWebhookServer } from './src/webhook.js';
import { renderAttendance } from './src/report.js';

const PARTICIPANT_EVENTS = ['participant_events.join', 'participant_events.leave'];

async function fetchRoster(client, botId) {
  try {
    const { status, data } = await client.getParticipants(botId);
    if (status === 202) {
      console.log('  roster still processing (HTTP 202) - skipping reconciliation');
      return null;
    }
    return data;
  } catch (err) {
    console.warn(`  could not fetch the participant roster: ${err.message}`);
    return null;
  }
}

async function fetchDetail(client, botId) {
  try {
    const { data } = await client.getDetail(botId);
    return data?.bot_details ?? null;
  } catch (err) {
    console.warn(`  could not fetch bot detail: ${err.message}`);
    return null;
  }
}

/** Rebuild attendance for a bot that already ran. */
async function reportMode(client, botId) {
  console.log(`Report mode: rebuilding attendance for bot ${botId}.`);

  const details = await fetchDetail(client, botId);
  const tracker = trackerFromStoredEvents(details?.participant_events);

  if (tracker.log.length === 0) {
    console.log(
      '  bot_details.participant_events was empty. Join/leave events are only\n' +
        '  stored when the bot was created with realtime_endpoints subscribing to\n' +
        '  participant_events. Falling back to the roster snapshot alone.'
    );
  } else {
    console.log(`  replayed ${tracker.log.length} stored join/leave events`);
  }

  const roster = await fetchRoster(client, botId);
  if (roster) {
    const added = tracker.applyRoster(roster);
    console.log(`  roster returned ${Array.isArray(roster) ? roster.length : 0} entries (${added} new)`);
  }

  return tracker.buildReport({
    botId,
    fallbackStart: details?.StartTime ?? null,
    fallbackEnd: details?.EndTime ?? null,
  });
}

/** Send a bot in and watch attendance live over webhooks. */
async function liveMode(client) {
  const meetingLink = (process.env.MEETING_LINK || '').trim();
  const publicUrl = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const port = envInt('PORT', 3000);

  if (!publicUrl) {
    throw new Error(
      'PUBLIC_URL is required in live mode - MeetStream has to reach your webhook\n' +
        'from the internet. Expose your local port with a tunnel, for example:\n' +
        `  ngrok http ${port}\n` +
        '  cloudflared tunnel --url http://localhost:' +
        port +
        '\n' +
        'then set PUBLIC_URL to the https:// address it prints.'
    );
  }
  if (!/^https?:\/\//.test(publicUrl)) {
    throw new Error(`PUBLIC_URL must include the scheme, e.g. https://example.ngrok-free.app (got "${publicUrl}")`);
  }

  const tracker = new AttendanceTracker();

  let signalEnd;
  const endedByWebhook = new Promise((resolve) => {
    signalEnd = resolve;
  });

  const { close } = await startWebhookServer({
    tracker,
    port,
    onMeetingEnded: (reason) => signalEnd(reason),
  });
  console.log(`Webhook server listening on http://localhost:${port}`);
  console.log(`  lifecycle    -> ${publicUrl}/webhook`);
  console.log(`  participants -> ${publicUrl}/participants`);

  let botId = null;
  try {
    const payload = buildCreateBotPayload({
      meetingLink,
      botName: process.env.BOT_NAME || 'MeetStream Attendance Bot',
      extra: {
        callback_url: `${publicUrl}/webhook`,
        recording_config: {
          realtime_endpoints: [
            {
              type: 'webhook',
              url: `${publicUrl}/participants`,
              events: PARTICIPANT_EVENTS,
            },
          ],
        },
      },
    });

    console.log(`\nCreating bot for ${meetingLink} ...`);
    const { replayed, data } = await client.createBot(payload, {
      idempotencyKey: process.env.IDEMPOTENCY_KEY || randomUUID(),
    });
    botId = data?.bot_id;
    if (!botId) throw new Error(`create_bot did not return a bot_id. Raw response: ${JSON.stringify(data)}`);
    console.log(`Bot created${replayed ? ' (idempotent replay, HTTP 507)' : ''}: ${botId}`);
    console.log('\nWatching the meeting. Ctrl+C to pull the bot out early and report.\n');

    // Two independent finish signals: the bot.stopped webhook, and polling
    // GET /bots/{id}/status. Whichever lands first wins, so a dropped webhook
    // cannot hang the run.
    const polled = client
      .waitForTerminalStatus(botId, {
        intervalMs: envInt('STATUS_POLL_INTERVAL_MS', 15_000),
        maxAttempts: envInt('STATUS_POLL_MAX_ATTEMPTS', 240),
      })
      .then((r) => `status poll: ${r.timedOut ? 'timed out' : r.status}`);

    let interrupted = false;
    const interruptedByUser = new Promise((resolve) => {
      process.once('SIGINT', () => {
        interrupted = true;
        console.log('\nCtrl+C received - removing the bot and reporting.');
        resolve('interrupted by user');
      });
    });

    const reason = await Promise.race([endedByWebhook, polled, interruptedByUser]);
    console.log(`\nMeeting finished (${reason}).`);

    if (interrupted) {
      try {
        await client.removeBot(botId);
        console.log('  remove_bot sent.');
      } catch (err) {
        console.warn(`  remove_bot failed: ${err.message}`);
      }
    }

    // Give trailing participant_events a moment to land.
    const drainMs = envInt('WEBHOOK_DRAIN_MS', 5_000);
    if (drainMs > 0) {
      console.log(`  waiting ${Math.round(drainMs / 1000)}s for trailing webhooks ...`);
      await sleep(drainMs);
    }

    console.log('  fetching the final roster ...');
    const roster = await fetchRoster(client, botId);
    if (roster) {
      const added = tracker.applyRoster(roster);
      console.log(`  roster returned ${Array.isArray(roster) ? roster.length : 0} entries (${added} new)`);
    }

    const details = await fetchDetail(client, botId);
    return tracker.buildReport({
      botId,
      fallbackStart: details?.StartTime ?? null,
      fallbackEnd: details?.EndTime ?? null,
    });
  } finally {
    await close();
  }
}

async function main() {
  const apiKey = readApiKey();
  const client = new MeetStreamClient({ apiKey, onRetry: (msg) => console.warn(`  ! ${msg}`) });

  const botId = (process.env.BOT_ID || '').trim();
  const meetingLink = (process.env.MEETING_LINK || '').trim();

  if (!botId && !meetingLink) {
    throw new Error(
      'Nothing to do. Set one of:\n' +
        '  BOT_ID                    - rebuild attendance for a past meeting\n' +
        '  MEETING_LINK + PUBLIC_URL - track a live meeting over webhooks\n' +
        'See .env.example.'
    );
  }

  const report = botId ? await reportMode(client, botId) : await liveMode(client);

  console.log(renderAttendance(report));

  const outDir = process.env.OUTPUT_DIR || './output';
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `attendance-${report.bot_id}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nAttendance report written to ${file}`);
}

main().catch((err) => {
  if (err instanceof MeetStreamError) {
    console.error(`\nAPI error: ${err.message}`);
    if (err.status === 404) console.error('Check the bot id and its retention window.');
    if (err.status === 400) {
      console.error(
        'If this was create_bot, the usual causes are an unreachable realtime_endpoints\n' +
          'URL or in_call_recording_timeout below its 600 second minimum.'
      );
    }
  } else {
    console.error(`\n${err.message}`);
  }
  process.exitCode = 1;
});
