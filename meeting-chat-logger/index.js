#!/usr/bin/env node
/**
 * meeting-chat-logger
 *
 * Exports the in-meeting chat captured by a MeetStream bot to JSON and
 * Markdown, with timestamps and authors.
 *
 *   BOT_ID set        -> export chat from a meeting that already happened
 *   MEETING_LINK set  -> send a bot in, wait for the call to end, then export
 *
 * Run: npm install && node index.js
 */

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MeetStreamClient, MeetStreamError, envInt, pollUntilReady, readApiKey } from './src/client.js';
import { resolveBot } from './src/session.js';
import { normalizeChats } from './src/normalize.js';
import { buildJson, buildMarkdown, renderPreview } from './src/exporters.js';

async function fetchMeetingMeta(client, botId) {
  try {
    const { data } = await client.getDetail(botId);
    const d = data?.bot_details;
    if (!d) return null;
    return {
      MeetingLink: d.MeetingLink ?? null,
      Platform: d.Platform ?? null,
      StartTime: d.StartTime ?? null,
      EndTime: d.EndTime ?? null,
      Duration: d.Duration ?? null,
      Status: d.Status ?? null,
    };
  } catch (err) {
    console.warn(`  could not fetch meeting metadata: ${err.message}`);
    return null;
  }
}

async function main() {
  const apiKey = readApiKey();
  const client = new MeetStreamClient({ apiKey, onRetry: (msg) => console.warn(`  ! ${msg}`) });

  const { botId } = await resolveBot(client, { botNameDefault: 'MeetStream Chat Logger' });

  console.log('\nFetching the in-meeting chat ...');
  const maxAttempts = envInt('CHAT_POLL_MAX_ATTEMPTS', 12);
  const intervalMs = envInt('CHAT_POLL_INTERVAL_MS', 10_000);
  const { data: raw } = await pollUntilReady(() => client.getChats(botId), {
    intervalMs,
    maxAttempts,
    label: 'The chat log',
    onWait: (attempt) =>
      console.log(
        `  still processing (HTTP 202) - attempt ${attempt}/${maxAttempts}, ` +
          `retrying in ${Math.round(intervalMs / 1000)}s`
      ),
  });

  const normalized = normalizeChats(raw);
  console.log(`Captured ${normalized.total} chat message${normalized.total === 1 ? '' : 's'}.`);

  const meetingMeta = await fetchMeetingMeta(client, botId);

  console.log(renderPreview(normalized, { botId, limit: envInt('PREVIEW_LIMIT', 20) }));

  const outDir = process.env.OUTPUT_DIR || './output';
  await mkdir(outDir, { recursive: true });

  const jsonFile = path.join(outDir, `chat-${botId}.json`);
  await writeFile(
    jsonFile,
    `${JSON.stringify(buildJson({ botId, raw, normalized, meetingMeta }), null, 2)}\n`,
    'utf8'
  );

  const mdFile = path.join(outDir, `chat-${botId}.md`);
  await writeFile(mdFile, buildMarkdown({ botId, normalized, meetingMeta }), 'utf8');

  console.log(`\nJSON export     ${jsonFile}`);
  console.log(`Markdown export ${mdFile}`);
}

main().catch((err) => {
  if (err instanceof MeetStreamError) {
    console.error(`\nAPI error: ${err.message}`);
    if (err.status === 404) {
      console.error('No chat data for that bot id. Check the id and its retention window.');
    }
    if (err.status === 202) {
      console.error(
        'The chat log was still processing when the poll cap was hit. Re-run later\n' +
          'with BOT_ID set, or raise CHAT_POLL_MAX_ATTEMPTS.'
      );
    }
  } else {
    console.error(`\n${err.message}`);
  }
  process.exitCode = 1;
});
