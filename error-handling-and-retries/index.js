#!/usr/bin/env node
/**
 * MeetStream Labs - error-handling-and-retries
 *
 * Walks the entire MeetStream error surface with a production-grade client:
 * 400, 401 vs 403, 404, 409, 429 with Retry-After, 500/503 backoff,
 * 507 treated as SUCCESS, and 202 polling with a hard cap.
 *
 *   node index.js          offline matrix (deterministic, free, no API key)
 *   node index.js --live   plus real-API probes for 401 / 403 / 400 / 404
 *   node index.js --table  print the status decision table and exit
 */
import 'dotenv/config';
import { offlineDemos, liveDemos } from './src/demos.js';
import { STATUS_GUIDE } from './src/errors.js';
import { log } from './src/logger.js';

const args = new Set(process.argv.slice(2));
const LIVE = args.has('--live');
const TABLE_ONLY = args.has('--table');

const baseUrl = process.env.MEETSTREAM_BASE_URL || 'https://api.meetstream.ai/api/v1';
const apiKey = process.env.MEETSTREAM_API_KEY;

if (TABLE_ONLY) {
  printTable();
  process.exit(0);
}

const results = [];

log.banner('Offline error matrix (mock transport, no network, no cost)');

for (const demo of offlineDemos) {
  console.log('');
  log.info(`>> ${demo.name}`);
  try {
    const outcome = await demo.run();
    results.push({ name: demo.name, ...outcome });
    outcome.ok ? log.ok(outcome.note) : log.error(outcome.note);
  } catch (err) {
    results.push({ name: demo.name, ok: false, note: err.message });
    log.error(`demo threw: ${err.message}`);
  }
}

if (LIVE) {
  log.banner('Live probes against the real API');
  log.info('These only trigger validation and auth failures. Nothing is created and nothing is charged.');

  for (const demo of liveDemos) {
    if (demo.needsKey && !apiKey) {
      log.warn(`skipping "${demo.name}": MEETSTREAM_API_KEY is not set`);
      continue;
    }
    console.log('');
    log.info(`>> ${demo.name}`);
    try {
      const outcome = await demo.run({ baseUrl, apiKey });
      results.push({ name: demo.name, ...outcome });
      outcome.ok ? log.ok(outcome.note) : log.error(outcome.note);
    } catch (err) {
      results.push({ name: demo.name, ok: false, note: err.message });
      log.error(`demo threw: ${err.message}`);
    }
  }
} else {
  console.log('');
  log.info('Run with --live to also probe 401 / 403 / 400 / 404 against the real API.');
}

printTable();

log.banner('Summary');
const passed = results.filter((r) => r.ok).length;
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
}
console.log('');
log.info(`${passed}/${results.length} demos behaved as documented.`);
process.exit(passed === results.length ? 0 : 1);

function printTable() {
  log.banner('Status decision table');
  console.log('  code  category           retry?  what to do');
  console.log('  ----  -----------------  ------  ------------------------------------------------');
  for (const [code, meta] of Object.entries(STATUS_GUIDE)) {
    const retry = meta.retryable ? 'yes' : 'no';
    console.log(`  ${code.padEnd(4)}  ${meta.category.padEnd(17)}  ${retry.padEnd(6)}  ${meta.hint}`);
  }
  console.log('');
}
