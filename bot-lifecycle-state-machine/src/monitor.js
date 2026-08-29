import { STATES, STATE_TIMEOUTS_MS, summarizeOutcome } from './machine.js';
import { log } from './logger.js';

/**
 * Stuck and abandoned bot detection.
 *
 * Nothing in the webhook stream tells you that a bot went silent. If a
 * `callback_url` is wrong, or a meeting link was dead, or the pipeline stalled,
 * you simply stop receiving events. The only way to notice is to watch the
 * clock yourself.
 *
 * Two distinct conditions:
 *
 *   STUCK      the bot has been in one non-terminal state longer than that
 *              state's budget. It might still recover.
 *   ABANDONED  no webhook of any kind for a long time, on a bot that never
 *              reached a terminal state. It will not recover on its own.
 *
 * A bot that never left `created` is the single most common real case, and it
 * almost always means the `callback_url` was unreachable.
 */

export function inspect(record, now = Date.now()) {
  const meta = STATES[record.state];
  if (meta.terminal) return { level: 'ok', reason: 'terminal' };

  const inStateMs = now - new Date(record.enteredStateAt).getTime();
  const sinceEventMs = record.lastEventAt ? now - new Date(record.lastEventAt).getTime() : inStateMs;
  const budget = STATE_TIMEOUTS_MS[record.state] ?? 60 * 60 * 1000;

  if (record.state === 'created' && inStateMs > STATE_TIMEOUTS_MS.created) {
    return {
      level: 'abandoned',
      reason:
        'No webhook has ever arrived for this bot. Almost always a callback_url that MeetStream cannot reach: it must be public HTTPS, and it is set per bot on create_bot.',
      inStateMs,
      sinceEventMs,
      budget: STATE_TIMEOUTS_MS.created,
    };
  }

  // Silent for four times the state budget is not "slow", it is gone.
  if (sinceEventMs > budget * 4) {
    return {
      level: 'abandoned',
      reason: `No events for ${fmt(sinceEventMs)} while in "${record.state}". This run will not complete on its own.`,
      inStateMs,
      sinceEventMs,
      budget,
    };
  }

  if (inStateMs > budget) {
    return {
      level: 'stuck',
      reason: `${fmt(inStateMs)} in "${record.state}", budget is ${fmt(budget)}. ${adviceFor(record)}`,
      inStateMs,
      sinceEventMs,
      budget,
    };
  }

  return { level: 'ok', reason: `${fmt(inStateMs)} in "${record.state}"`, inStateMs, sinceEventMs, budget };
}

function adviceFor(record) {
  switch (record.state) {
    case 'joining':
      return 'Check the meeting_link is valid and the meeting has actually started.';
    case 'waiting_room':
      return 'Nobody is admitting the bot. automatic_leave.waiting_room_timeout should end this with bot.stopped / NotAllowed.';
    case 'recording':
    case 'in_meeting':
      return 'Long meeting, or automatic_leave.in_call_recording_timeout is set high (its minimum is 600 seconds).';
    case 'stopped':
    case 'stopped_error':
      return 'The meeting ended but processing never started. Check GET /bots/{id}/detail.';
    case 'processing':
    case 'media_ready':
    case 'transcribed':
      return record.streamingOnly
        ? 'This bot is marked streaming-only, so it should have finished at audio.processed. Verify the streamingOnly flag is right.'
        : 'Post-processing is running long. Verify with GET /bots/{id}/detail before re-triggering anything.';
    default:
      return '';
  }
}

/** Scan every open bot. Returns only the ones that need attention. */
export function scan(store, now = Date.now()) {
  const findings = [];
  for (const record of store.open()) {
    const verdict = inspect(record, now);
    if (verdict.level !== 'ok') findings.push({ record, verdict });
  }
  return findings;
}

/** Periodic scan that logs findings. Returns a stop function. */
export function startMonitor(store, { intervalMs = 30_000, onFinding } = {}) {
  const tick = () => {
    const findings = scan(store);
    if (!findings.length) return;
    log.banner(`Monitor: ${findings.length} bot(s) need attention`);
    for (const { record, verdict } of findings) {
      const line = `${record.botId}  ${verdict.level.toUpperCase()}  state=${record.state}`;
      verdict.level === 'abandoned' ? log.error(line) : log.warn(line);
      log.detail('why', verdict.reason);
      onFinding?.({ record, verdict });
    }
    console.log('');
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** One-line-per-bot table of everything the store knows. */
export function report(store) {
  const rows = store.all().map((r) => {
    const verdict = inspect(r);
    const outcome = summarizeOutcome(r);
    return {
      botId: r.botId,
      path: r.streamingOnly ? 'streaming' : 'post-call',
      state: r.state,
      health: verdict.level,
      outcome: outcome?.outcome ?? 'in-flight',
      stopReason: r.stopReason ?? '-',
      events: r.history.length,
    };
  });

  const totals = rows.reduce((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});

  return { rows, totals };
}

function fmt(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}
