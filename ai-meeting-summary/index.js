#!/usr/bin/env node
/**
 * ai-meeting-summary
 *
 * Fetches MeetStream's native AI meeting summary for a bot and prints it in
 * a readable form.
 *
 *   BOT_ID set        -> summarise a meeting that already happened
 *   MEETING_LINK set  -> send a bot in, wait for the call to end, then summarise
 *
 * Run: npm install && node index.js
 */

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MeetStreamClient, MeetStreamError, readApiKey } from './src/client.js';
import { resolveBot } from './src/session.js';
import { fetchSummary } from './src/summary.js';
import { renderSummary } from './src/render.js';

async function main() {
  const apiKey = readApiKey();
  const client = new MeetStreamClient({
    apiKey,
    onRetry: (msg) => console.warn(`  ! ${msg}`),
  });

  const { botId } = await resolveBot(client, { botNameDefault: 'MeetStream Summary Bot' });

  console.log('\nFetching the AI summary ...');
  const { raw, body, attempts } = await fetchSummary(client, botId);
  console.log(`Summary retrieved after ${attempts} request${attempts === 1 ? '' : 's'}.`);

  console.log(
    renderSummary(body, {
      showAll: String(process.env.SHOW_ALL_FIELDS).toLowerCase() === 'true',
    })
  );

  const outDir = process.env.OUTPUT_DIR || './output';
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `summary-${botId}.json`);
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  console.log(`\nRaw response written to ${file}`);
}

main().catch((err) => {
  if (err instanceof MeetStreamError) {
    console.error(`\nAPI error: ${err.message}`);
    if (err.status === 404) {
      console.error(
        'Nothing to summarise for that bot id. Confirm the id, and that its data has not\n' +
          'expired via the retention window you set on create_bot.'
      );
    }
    if (err.status === 202) {
      console.error(
        'The summary was still generating when the poll cap was hit. Raise\n' +
          'SUMMARY_POLL_MAX_ATTEMPTS, or re-run later with BOT_ID set to this bot.'
      );
    }
  } else {
    console.error(`\n${err.message}`);
  }
  process.exitCode = 1;
});
