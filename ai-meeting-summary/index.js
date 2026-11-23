#!/usr/bin/env node
/**
 * ai-meeting-summary
 *
 * Fetches a bot's post-call transcript from MeetStream and prints a local
 * meeting digest: talk share per speaker and the opening lines. MeetStream has
 * no summary endpoint; for a written summary, pass the transcript to your own LLM.
 *
 *   BOT_ID set        -> digest a meeting that already happened
 *   MEETING_LINK set  -> send a bot in, wait for the call to end, then digest it
 *
 * Run: npm install && node index.js
 */

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MeetStreamClient, MeetStreamError, envInt, readApiKey } from './src/client.js';
import { resolveBot } from './src/session.js';
import { buildDigest, fetchTranscript } from './src/summary.js';
import { renderDigest } from './src/render.js';

async function main() {
  const apiKey = readApiKey();
  const client = new MeetStreamClient({
    apiKey,
    onRetry: (msg) => console.warn(`  ! ${msg}`),
  });

  const { botId } = await resolveBot(client, { botNameDefault: 'MeetStream Summary Bot' });

  console.log('\nFetching the transcript ...');
  const { transcriptId, segments, attempts } = await fetchTranscript(client, botId);
  console.log(
    `Transcript ${transcriptId} retrieved after ${attempts} request${attempts === 1 ? '' : 's'} ` +
      `(${segments.length} segments).`
  );

  const digest = buildDigest(segments, { openingLines: envInt('DIGEST_OPENING_LINES', 10) });
  console.log(renderDigest(digest));

  const outDir = process.env.OUTPUT_DIR || './output';
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `digest-${botId}.json`);
  await writeFile(
    file,
    `${JSON.stringify({ bot_id: botId, transcript_id: transcriptId, ...digest }, null, 2)}\n`,
    'utf8'
  );
  console.log(`\nDigest written to ${file}`);
}

main().catch((err) => {
  if (err instanceof MeetStreamError) {
    console.error(`\nAPI error: ${err.message}`);
    if (err.status === 404) {
      console.error(
        'Nothing to digest for that bot id. Confirm the id, and that its data has not\n' +
          'expired via the retention window you set on create_bot.'
      );
    }
    if (err.status === 202) {
      console.error(
        'The transcript was still processing when the poll cap was hit. Raise\n' +
          'TRANSCRIPT_POLL_MAX_ATTEMPTS, or re-run later with BOT_ID set to this bot.'
      );
    }
  } else {
    console.error(`\n${err.message}`);
  }
  process.exitCode = 1;
});
