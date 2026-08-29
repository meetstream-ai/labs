#!/usr/bin/env node
/**
 * meeting-analytics-dashboard
 *
 * Everything MeetStream knows about one meeting, in one report.
 *
 * Reads five endpoints - detail, participants, speaker timeline, chats and
 * the AI summary - and writes a consolidated JSON file plus a readable
 * Markdown document, with a dashboard printed to the terminal.
 *
 *   BOT_ID set        -> report on a meeting that already happened
 *   MEETING_LINK set  -> send a bot in, wait for the call to end, then report
 *
 * Run: npm install && node index.js
 */

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MeetStreamClient, MeetStreamError, envInt, readApiKey } from './src/client.js';
import { resolveBot } from './src/session.js';
import { collectMeeting } from './src/collect.js';
import { buildReport, renderDashboard, renderMarkdown } from './src/dashboard.js';

async function main() {
  const apiKey = readApiKey();
  const client = new MeetStreamClient({ apiKey, onRetry: (msg) => console.warn(`  ! ${msg}`) });

  const { botId } = await resolveBot(client, { botNameDefault: 'MeetStream Analytics Bot' });

  console.log('\nCollecting meeting data ...');
  const collected = await collectMeeting(client, botId, {
    intervalMs: envInt('SECTION_POLL_INTERVAL_MS', 10_000),
    maxAttempts: envInt('SECTION_POLL_MAX_ATTEMPTS', 12),
    onLog: (msg) => console.log(msg),
  });

  if (collected.detail.status === 'missing') {
    throw new MeetStreamError(
      404,
      `No bot found with id ${botId}. Check the id, and whether its data has expired ` +
        'via the retention window set on create_bot.',
      null
    );
  }

  const report = buildReport(collected, {
    bytesPerSample: envInt('AUDIO_BYTES_PER_SAMPLE', 2),
    channels: envInt('AUDIO_CHANNELS', 1),
  });

  console.log(renderDashboard(report, { barWidth: envInt('BAR_WIDTH', 30) }));

  const outDir = process.env.OUTPUT_DIR || './output';
  await mkdir(outDir, { recursive: true });

  const includeRaw = String(process.env.INCLUDE_RAW_RESPONSES ?? 'true').toLowerCase() !== 'false';
  const jsonPayload = includeRaw ? report : { ...report, raw: undefined };

  const jsonFile = path.join(outDir, `meeting-report-${botId}.json`);
  await writeFile(jsonFile, `${JSON.stringify(jsonPayload, null, 2)}\n`, 'utf8');

  const mdFile = path.join(outDir, `meeting-report-${botId}.md`);
  await writeFile(mdFile, renderMarkdown(report), 'utf8');

  console.log(`\nJSON report     ${jsonFile}`);
  console.log(`Markdown report ${mdFile}`);

  const degraded = Object.entries(report.sections).filter(([, s]) => s !== 'ok');
  if (degraded.length > 0) {
    console.log(
      `\nNote: ${degraded.length} of 5 sources were unavailable ` +
        `(${degraded.map(([k]) => k).join(', ')}). See "Data sources" above for why.`
    );
  }
}

main().catch((err) => {
  if (err instanceof MeetStreamError) {
    console.error(`\nAPI error: ${err.message}`);
    if (err.status === 401 || err.status === 403) {
      console.error('Check MEETSTREAM_API_KEY. The header is `Authorization: Token <key>`.');
    }
  } else {
    console.error(`\n${err.message}`);
  }
  process.exitCode = 1;
});
