#!/usr/bin/env node
/**
 * speaker-timeline-analytics
 *
 * Pulls GET /bots/{id}/get_speaker_timeline and turns it into conversation
 * metrics: talk-time per speaker, turn counts, longest monologue, overlapping
 * speech, plus an ASCII bar chart of talk-time share.
 *
 *   BOT_ID set        -> analyse a meeting that already happened
 *   MEETING_LINK set  -> send a bot in, wait for the call to end, then analyse
 *
 * Run: npm install && node index.js
 */

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MeetStreamClient, MeetStreamError, envInt, pollUntilReady, readApiKey } from './src/client.js';
import { resolveBot } from './src/session.js';
import { analyzeTimeline } from './src/analytics.js';
import { renderReport } from './src/report.js';

async function main() {
  const apiKey = readApiKey();
  const client = new MeetStreamClient({
    apiKey,
    onRetry: (msg) => console.warn(`  ! ${msg}`),
  });

  const { botId } = await resolveBot(client, { botNameDefault: 'MeetStream Analytics Bot' });

  console.log('\nFetching the speaker timeline ...');
  const maxAttempts = envInt('TIMELINE_POLL_MAX_ATTEMPTS', 20);
  const intervalMs = envInt('TIMELINE_POLL_INTERVAL_MS', 10_000);
  const { data: timeline } = await pollUntilReady(() => client.getSpeakerTimeline(botId), {
    intervalMs,
    maxAttempts,
    label: 'The speaker timeline',
    onWait: (attempt) =>
      console.log(
        `  still processing (HTTP 202) - attempt ${attempt}/${maxAttempts}, ` +
          `retrying in ${Math.round(intervalMs / 1000)}s`
      ),
  });

  const stats = analyzeTimeline(timeline, {
    bytesPerSample: envInt('AUDIO_BYTES_PER_SAMPLE', 2),
    channels: envInt('AUDIO_CHANNELS', 1),
  });

  console.log(
    renderReport(stats, {
      botId,
      barWidth: envInt('BAR_WIDTH', 30),
    })
  );

  const outDir = process.env.OUTPUT_DIR || './output';
  await mkdir(outDir, { recursive: true });

  const rawFile = path.join(outDir, `speaker-timeline-${botId}.json`);
  await writeFile(rawFile, `${JSON.stringify(timeline, null, 2)}\n`, 'utf8');

  const statsFile = path.join(outDir, `speaker-analytics-${botId}.json`);
  const serialisable = {
    bot_id: botId,
    generated_at: new Date().toISOString(),
    assumptions: {
      bytes_per_sample: envInt('AUDIO_BYTES_PER_SAMPLE', 2),
      channels: envInt('AUDIO_CHANNELS', 1),
      sample_rate: stats.sampleRate,
      note: 'startByte/endByte are byte offsets into the audio file, not time offsets.',
    },
    totals: {
      speakers: stats.speakers.length,
      turns: stats.turnCount,
      chunks: stats.chunkCount,
      speech_bytes: stats.totalBytes,
      speech_seconds: stats.totalSeconds,
      recording_seconds: stats.audioSeconds,
      silence_seconds: stats.silenceSeconds,
      overlapping_starts: stats.overlapCount,
    },
    speakers: stats.speakers,
    longest_monologue: stats.longestMonologue,
    overlaps: stats.overlaps,
  };
  await writeFile(statsFile, `${JSON.stringify(serialisable, null, 2)}\n`, 'utf8');

  console.log(`\nRaw timeline written to  ${rawFile}`);
  console.log(`Computed metrics written to ${statsFile}`);
}

main().catch((err) => {
  if (err instanceof MeetStreamError) {
    console.error(`\nAPI error: ${err.message}`);
    if (err.status === 404) {
      console.error('No speaker timeline for that bot id. Check the id and its retention window.');
    }
    if (err.status === 202) {
      console.error(
        'The timeline was still processing when the poll cap was hit. Re-run later\n' +
          'with BOT_ID set, or raise TIMELINE_POLL_MAX_ATTEMPTS.'
      );
    }
  } else {
    console.error(`\n${err.message}`);
  }
  process.exitCode = 1;
});
