#!/usr/bin/env node
/**
 * MeetStream Labs - bot-lifecycle-state-machine
 *
 * Models the bot lifecycle as an explicit state machine driven by webhooks,
 * persists it to a JSON file, and flags bots that are stuck or abandoned.
 *
 *   node index.js            run the receiver + monitor
 *   node index.js --replay   replay every lifecycle path offline, then report
 *   node index.js --report   print the persisted state file and exit
 */
import 'dotenv/config';
import { BotStore } from './src/store.js';
import { createServer } from './src/server.js';
import { startMonitor, report, inspect } from './src/monitor.js';
import { allScenarios, replay } from './src/scenarios.js';
import { STATES } from './src/machine.js';
import { log } from './src/logger.js';

const args = new Set(process.argv.slice(2));
const REPLAY = args.has('--replay');
const REPORT_ONLY = args.has('--report');

const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhook';
const STATE_FILE = process.env.STATE_FILE || './data/bots.json';
const MONITOR_INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS || 30_000);
const DEFAULT_STREAMING_ONLY = process.env.DEFAULT_STREAMING_ONLY === 'true';

const store = new BotStore(STATE_FILE);

if (REPORT_ONLY) {
  printReport();
  process.exit(0);
}

const stopAutoSave = store.autoSave(2000);
const { app } = createServer({
  store,
  webhookPath: WEBHOOK_PATH,
  defaultStreamingOnly: DEFAULT_STREAMING_ONLY,
});

const server = app.listen(PORT, async () => {
  log.banner('MeetStream bot lifecycle state machine');
  log.detail('listening', `http://localhost:${PORT}`);
  log.detail('webhook path', `POST ${WEBHOOK_PATH}`);
  log.detail('state file', STATE_FILE);
  log.detail('known bots', String(store.all().length));
  log.detail('open bots', String(store.open().length));
  log.detail('default path', DEFAULT_STREAMING_ONLY ? 'streaming-only' : 'post-call');
  console.log('');
  log.info('Inspect:  GET /bots   GET /bots/:botId   GET /states   GET /health');
  console.log('');

  startMonitor(store, { intervalMs: MONITOR_INTERVAL_MS });

  if (REPLAY) await runReplay();
  else {
    log.info(`Waiting for deliveries. Monitor scans every ${Math.round(MONITOR_INTERVAL_MS / 1000)}s.`);
    log.info('No public URL yet? See the webhook-local-tunnel template.');
    log.info('Want to see every path offline? Run:  node index.js --replay');
  }
});

async function runReplay() {
  log.banner('REPLAY (synthetic envelopes, no API calls)');

  // Seed a bot that was created but never produced a single webhook. This is
  // the most common real failure and the monitor should call it out.
  const ghost = store.upsert('lc-ghost-no-webhooks', {
    meta: { note: 'created via API but callback_url was unreachable' },
  });
  const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  ghost.createdAt = twentyMinAgo;
  ghost.enteredStateAt = twentyMinAgo;
  store.touch();

  // Seed a bot that started processing and then went silent.
  const stalled = store.upsert('lc-stalled-in-processing', { streamingOnly: false });
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  stalled.state = 'processing';
  stalled.createdAt = threeHoursAgo;
  stalled.enteredStateAt = threeHoursAgo;
  stalled.lastEventAt = threeHoursAgo;
  store.touch();

  const url = `http://localhost:${PORT}${WEBHOOK_PATH}`;
  const results = await replay(allScenarios(), url, { delayMs: 40 });
  log.info(`replayed ${results.length} deliveries, all ACKed ${results.every((r) => r.status === 200) ? '200' : 'with mixed statuses'}`);

  store.save({ force: true });
  printReport();

  log.banner('Monitor scan');
  const findings = [];
  for (const record of store.open()) {
    const verdict = inspect(record);
    if (verdict.level !== 'ok') findings.push({ record, verdict });
  }
  if (!findings.length) log.ok('no stuck or abandoned bots');
  for (const { record, verdict } of findings) {
    verdict.level === 'abandoned'
      ? log.error(`${record.botId}  ABANDONED  state=${record.state}`)
      : log.warn(`${record.botId}  STUCK  state=${record.state}`);
    log.detail('why', verdict.reason);
  }
  console.log('');
  log.ok(`Replay complete. State persisted to ${STATE_FILE}. Server is still up, Ctrl+C to exit.`);
  log.info('Restart with --report to prove the state survived the process.');
}

function printReport() {
  const { rows, totals } = report(store);
  log.banner('Bot ledger');
  if (!rows.length) {
    log.info('no bots recorded yet');
    return;
  }
  console.log(
    `  ${'bot_id'.padEnd(28)}${'path'.padEnd(11)}${'state'.padEnd(22)}${'health'.padEnd(11)}${'outcome'.padEnd(11)}${'stop'.padEnd(12)}events`,
  );
  console.log(`  ${'-'.repeat(100)}`);
  for (const r of rows) {
    console.log(
      `  ${r.botId.padEnd(28)}${r.path.padEnd(11)}${r.state.padEnd(22)}${r.health.padEnd(11)}${String(r.outcome).padEnd(11)}${String(r.stopReason).padEnd(12)}${r.events}`,
    );
  }
  console.log('');
  log.detail('totals', Object.entries(totals).map(([k, v]) => `${k}=${v}`).join('  '));
  log.detail(
    'terminal states',
    Object.entries(STATES)
      .filter(([, m]) => m.terminal)
      .map(([n]) => n)
      .join(', '),
  );
  console.log('');
}

process.on('SIGINT', () => {
  console.log('');
  log.info('shutting down, flushing state');
  stopAutoSave();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
