import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from './logger.js';

/**
 * Aggregate the batch into something you can act on, and write it to disk.
 *
 * The written report is not decoration. It is what you feed back in to re-run
 * only the failures, and what proves which bots this batch is responsible for.
 */

export function aggregate({ batchId, results, invalid = [], startedAt, finishedAt }) {
  const created = [];
  const replayed = [];
  const failed = [];

  for (const r of results) {
    if (r.ok && r.value.replay) {
      replayed.push({
        jobId: r.job.id,
        botId: r.value.botId,
        transcriptId: r.value.transcriptId,
        durationMs: r.durationMs,
      });
    } else if (r.ok) {
      created.push({
        jobId: r.job.id,
        botId: r.value.botId,
        transcriptId: r.value.transcriptId,
        meetingLink: r.job.meetingLink,
        streamingOnly: r.job.streamingOnly,
        durationMs: r.durationMs,
      });
    } else {
      failed.push({
        jobId: r.job.id,
        meetingLink: r.job.meetingLink,
        status: r.error.status ?? null,
        category: r.error.category ?? 'unknown',
        message: r.error.message,
        retryable: Boolean(r.error.retryable),
        durationMs: r.durationMs,
      });
    }
  }

  // Group failures so 30 identical 429s read as one line, not thirty.
  const byReason = failed.reduce((acc, f) => {
    const key = `${f.status ?? 'network'} ${f.message}`;
    (acc[key] ??= []).push(f.jobId);
    return acc;
  }, {});

  return {
    batchId,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    elapsedMs: finishedAt - startedAt,
    totals: {
      submitted: results.length,
      created: created.length,
      replayed: replayed.length,
      failed: failed.length,
      rejectedBeforeSubmit: invalid.length,
    },
    created,
    replayed,
    failed,
    failuresByReason: byReason,
    invalid,
    // Re-run just these. Same batchId means finished jobs replay as 507.
    retryJobIds: failed.filter((f) => f.retryable).map((f) => f.jobId),
  };
}

export function printSummary(summary) {
  log.banner(`Batch ${summary.batchId} summary`);
  const t = summary.totals;
  log.detail('elapsed', `${(summary.elapsedMs / 1000).toFixed(1)}s`);
  log.detail('submitted', String(t.submitted));
  log.detail('created', String(t.created));
  log.detail('replayed (507, already existed)', String(t.replayed));
  log.detail('failed', String(t.failed));
  if (t.rejectedBeforeSubmit) {
    log.detail('rejected before submit (validation)', String(t.rejectedBeforeSubmit));
  }

  if (summary.created.length) {
    console.log('');
    log.info('Created bots:');
    for (const c of summary.created) {
      console.log(
        `    ${String(c.jobId).padEnd(20)} bot_id=${c.botId}  transcript_id=${c.transcriptId ?? 'null'}  ${c.streamingOnly ? '[streaming-only]' : '[post-call]'}`,
      );
    }
  }

  if (summary.replayed.length) {
    console.log('');
    log.info('Replayed (HTTP 507, the original request already succeeded):');
    for (const r of summary.replayed) {
      console.log(`    ${String(r.jobId).padEnd(20)} bot_id=${r.botId}`);
    }
  }

  if (Object.keys(summary.failuresByReason).length) {
    console.log('');
    log.warn('Failures, grouped by reason:');
    for (const [reason, jobIds] of Object.entries(summary.failuresByReason)) {
      console.log(`    ${jobIds.length}x  ${reason}`);
      console.log(`         jobs: ${jobIds.join(', ')}`);
    }
  }

  if (summary.invalid.length) {
    console.log('');
    log.warn('Rejected before submit (never reached the API):');
    for (const inv of summary.invalid) {
      console.log(`    ${inv.id}: ${inv.errors.join('; ')}`);
    }
  }

  if (summary.retryJobIds.length) {
    console.log('');
    log.info(
      `${summary.retryJobIds.length} failure(s) are retryable. Re-run the SAME file with the SAME --batch-id: finished jobs replay as 507 instead of duplicating.`,
    );
  }
  console.log('');
}

export function writeReport(summary, path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(summary, null, 2), 'utf8');
  log.ok(`report written to ${path}`);
  return path;
}
