#!/usr/bin/env node
/**
 * MeetStream Labs - bulk-bot-operations
 *
 * Run many bots at once: a concurrency-limited queue, a per-job Idempotency-Key
 * so retries and re-runs never duplicate, live progress, and an aggregated
 * report you can feed back in.
 *
 *   node index.js --simulate                     10 jobs against a fake API, no key needed
 *   node index.js --dry-run                      validate the file, call nothing
 *   node index.js --file jobs.json               real run
 *   node index.js --file jobs.json --batch-id nightly-2026-08-23 --concurrency 8
 *
 * Re-running with the SAME --batch-id and the SAME file replays finished jobs
 * (HTTP 507) instead of creating a second bot for every meeting.
 */
import 'dotenv/config';
import { MeetStreamClient } from './src/client.js';
import { Queue } from './src/queue.js';
import { loadJobs, validateJobs, toCreateBotPayload, idempotencyKeyFor } from './src/jobs.js';
import { createProgress } from './src/progress.js';
import { aggregate, printSummary, writeReport } from './src/report.js';
import { createSimulatedTransport } from './src/simulate.js';
import { log } from './src/logger.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const SIMULATE = has('simulate');
const DRY_RUN = has('dry-run');
const FILE = flag('file', SIMULATE ? './jobs.example.json' : process.env.JOBS_FILE || './jobs.json');
const CONCURRENCY = Number(flag('concurrency', process.env.CONCURRENCY || 5));
const STAGGER_MS = Number(flag('stagger', process.env.STAGGER_MS || 100));
const BATCH_ID = flag('batch-id', process.env.BATCH_ID || defaultBatchId());
const REPORT_PATH = flag('report', process.env.REPORT_PATH || `./output/batch-${BATCH_ID}.json`);

const apiKey = process.env.MEETSTREAM_API_KEY;
if (!SIMULATE && !DRY_RUN && !apiKey) {
  console.error(
    'Missing MEETSTREAM_API_KEY. Copy .env.example to .env and set your key from https://app.meetstream.ai\n' +
      'Or run without a key:  node index.js --simulate',
  );
  process.exit(1);
}

log.banner('MeetStream bulk bot operations');
log.detail('jobs file', FILE);
log.detail('batch id', BATCH_ID);
log.detail('concurrency', String(CONCURRENCY));
log.detail('stagger between starts', `${STAGGER_MS}ms`);
log.detail('mode', SIMULATE ? 'SIMULATE (fake API)' : DRY_RUN ? 'DRY RUN (no calls)' : 'LIVE');
console.log('');

// ---------------------------------------------------------------------------
// 1. Load and validate BEFORE touching the network.
// ---------------------------------------------------------------------------
let rawJobs;
try {
  rawJobs = loadJobs(FILE);
} catch (err) {
  log.error(`could not load ${FILE}: ${err.message}`);
  process.exit(1);
}

const defaults = {
  provider: process.env.DEFAULT_PROVIDER || 'deepgram',
  callbackUrl: process.env.CALLBACK_URL || null,
  botName: process.env.DEFAULT_BOT_NAME || undefined,
  videoRequired: process.env.DEFAULT_VIDEO_REQUIRED === 'true',
  customAttributes: { batch_id: BATCH_ID },
};

const { valid, invalid } = validateJobs(rawJobs, defaults);

log.info(`${rawJobs.length} job(s) in file: ${valid.length} valid, ${invalid.length} rejected`);
if (invalid.length) {
  console.log('');
  log.warn('Rejected before submit. These never reach the API, so nothing is half-created:');
  for (const inv of invalid) console.log(`    ${inv.id}: ${inv.errors.join('; ')}`);
}
console.log('');

if (!valid.length) {
  log.error('nothing to submit');
  process.exit(1);
}

if (DRY_RUN) {
  log.banner('Dry run: payloads that would be sent');
  for (const job of valid) {
    const payload = toCreateBotPayload(job);
    const key = idempotencyKeyFor(BATCH_ID, job, payload);
    console.log(`\n  ${job.id}  (Idempotency-Key ${key})`);
    console.log(
      JSON.stringify(payload, null, 2)
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n'),
    );
  }
  console.log('');
  log.ok(`${valid.length} job(s) would be submitted. Nothing was called.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Run the batch.
// ---------------------------------------------------------------------------
// The simulated API persists its key store, so re-running the same batch id
// really does replay as 507 rather than pretending to.
const simulated = SIMULATE
  ? createSimulatedTransport({ statePath: './output/.simulated-api-state.json' })
  : null;

const client = new MeetStreamClient({
  apiKey: apiKey ?? 'simulated-key',
  baseUrl: process.env.MEETSTREAM_BASE_URL || 'https://api.meetstream.ai/api/v1',
  fetchImpl: simulated?.fetchImpl,
  retry: {
    maxAttempts: Number(process.env.MAX_ATTEMPTS || 4),
    baseDelayMs: 500,
    maxDelayMs: 10_000,
    maxElapsedMs: 45_000,
  },
});

const progress = createProgress({ total: valid.length });
const queue = new Queue({
  concurrency: CONCURRENCY,
  staggerMs: STAGGER_MS,
  onUpdate: progress.onUpdate,
});

async function worker(job) {
  const payload = toCreateBotPayload(job);

  // Deterministic per job. Same batch + same job + same payload => same key,
  // so a re-run replays (507) instead of creating a duplicate bot. The retry
  // wrapper reuses this exact key across attempts, which is what makes
  // retrying a POST safe at all.
  const idempotencyKey = idempotencyKeyFor(BATCH_ID, job, payload);

  const res = await client.createBot(payload, {
    idempotencyKey,
    onRetry: (info) =>
      // Plain console.log, not the progress line, so a retry notice does not
      // get overwritten by the next progress-bar repaint.
      console.log(
        `\n  RETRY ${job.id}: attempt ${info.attempt}/${info.maxAttempts} in ${info.delayMs}ms` +
          `${info.honoredRetryAfter ? ' (Retry-After honored)' : ''} after ${info.status ?? 'network error'}: ${info.message}`,
      ),
  });

  return {
    replay: res.status === 507,
    status: res.status,
    botId: res.data?.bot_id ?? null,
    transcriptId: res.data?.transcript_id ?? null,
    idempotencyKey,
  };
}

log.info(`submitting ${valid.length} job(s), ${CONCURRENCY} at a time`);
console.log('');

const startedAt = Date.now();
const results = await queue.run(valid, worker);
const finishedAt = Date.now();

// ---------------------------------------------------------------------------
// 3. Report.
// ---------------------------------------------------------------------------
const summary = aggregate({ batchId: BATCH_ID, results, invalid, startedAt, finishedAt });
printSummary(summary);
writeReport(summary, REPORT_PATH);

if (SIMULATE) {
  console.log('');
  log.info('Simulation notes:');
  log.info('  507 REPLAY appears when you re-run this command with the same --batch-id.');
  log.info('  409 appears because two example jobs target the same meeting_link.');
  log.info('  503 then success shows the retry wrapper backing off.');
  log.info(`  Try it:  node index.js --simulate --batch-id ${BATCH_ID}`);
}

process.exit(summary.totals.failed > 0 ? 1 : 0);

function defaultBatchId() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}
