import { log } from './logger.js';

/**
 * Live progress for a batch.
 *
 * Renders a single updating line when stdout is a TTY, and plain one-line-per
 * -settlement output when it is not (CI logs, `| tee`, cron). Both paths carry
 * the same numbers.
 */
export function createProgress({ total, quiet = false }) {
  const counts = { created: 0, replayed: 0, failed: 0, done: 0 };
  const startedAt = Date.now();
  const isTTY = Boolean(process.stdout.isTTY) && !quiet;

  const render = (inFlight) => {
    if (!isTTY) return;
    const pct = total ? Math.round((counts.done / total) * 100) : 100;
    const width = 28;
    const filled = Math.round((pct / 100) * width);
    const bar = `${'#'.repeat(filled)}${'.'.repeat(width - filled)}`;
    const line =
      `  [${bar}] ${String(pct).padStart(3)}%  ` +
      `${counts.done}/${total}  ` +
      `created=${counts.created} replayed=${counts.replayed} failed=${counts.failed} ` +
      `inflight=${inFlight}`;
    process.stdout.write(`\r${line.padEnd(110)}`);
  };

  return {
    counts,

    onUpdate(update) {
      if (update.type === 'start') {
        render(update.inFlight);
        return;
      }
      if (update.type === 'settle') {
        const { result } = update;
        if (!result.ok) counts.failed += 1;
        else if (result.value?.replay) counts.replayed += 1;
        else counts.created += 1;
        counts.done = update.completed;

        if (isTTY) {
          render(update.inFlight);
        } else if (!quiet) {
          const status = result.ok
            ? result.value.replay
              ? `REPLAY  bot_id=${result.value.botId}`
              : `CREATED bot_id=${result.value.botId}`
            : `FAILED  ${result.error.status ?? 'network'}: ${result.error.message}`;
          console.log(
            `  [${String(update.completed).padStart(3)}/${update.total}] ${String(result.job.id).padEnd(20)} ${status}`,
          );
        }
        return;
      }
      if (update.type === 'done') {
        if (isTTY) process.stdout.write('\n');
        const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
        log.info(`batch finished in ${secs}s`);
      }
    },
  };
}
