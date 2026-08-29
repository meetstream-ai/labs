/**
 * A concurrency-limited work queue.
 *
 * Two reasons not to just do `await Promise.all(jobs.map(run))`:
 *
 *   1. Fifty simultaneous create_bot calls will get you rate limited, and then
 *      all fifty back off and retry in lockstep.
 *   2. One rejected promise in Promise.all abandons the result of every other
 *      job. In bulk work you almost always want every job's outcome, including
 *      the failures.
 *
 * This runs at most `concurrency` jobs at a time, never throws for a single
 * job failure, and reports each settlement as it happens so a caller can draw
 * a live progress bar.
 */
export class Queue {
  /**
   * @param {object} opts
   * @param {number} [opts.concurrency]
   * @param {number} [opts.staggerMs]  delay between STARTS, smooths burst load
   * @param {(update:object)=>void} [opts.onUpdate]
   */
  constructor({ concurrency = 5, staggerMs = 0, onUpdate } = {}) {
    if (concurrency < 1) throw new Error('concurrency must be at least 1');
    this.concurrency = concurrency;
    this.staggerMs = staggerMs;
    this.onUpdate = onUpdate;
  }

  /**
   * @param {Array<object>} jobs
   * @param {(job:object, ctx:object)=>Promise<any>} worker
   * @returns {Promise<Array<{job:object, ok:boolean, value?:any, error?:Error, startedAt:number, durationMs:number}>>}
   */
  async run(jobs, worker) {
    const results = new Array(jobs.length);
    const total = jobs.length;
    let nextIndex = 0;
    let completed = 0;
    let inFlight = 0;

    const startedAt = Date.now();

    const runOne = async (index) => {
      const job = jobs[index];
      const jobStart = Date.now();
      inFlight += 1;
      this.onUpdate?.({ type: 'start', job, index, total, inFlight, completed });

      try {
        const value = await worker(job, { index, total });
        results[index] = { job, ok: true, value, startedAt: jobStart, durationMs: Date.now() - jobStart };
      } catch (error) {
        // A single failure never stops the batch.
        results[index] = { job, ok: false, error, startedAt: jobStart, durationMs: Date.now() - jobStart };
      } finally {
        inFlight -= 1;
        completed += 1;
        this.onUpdate?.({
          type: 'settle',
          job,
          index,
          total,
          inFlight,
          completed,
          result: results[index],
        });
      }
    };

    const workerLoop = async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= jobs.length) return;
        if (this.staggerMs && index > 0) await sleep(this.staggerMs);
        await runOne(index);
      }
    };

    const lanes = Array.from({ length: Math.min(this.concurrency, jobs.length) }, workerLoop);
    await Promise.all(lanes);

    this.onUpdate?.({ type: 'done', total, completed, elapsedMs: Date.now() - startedAt });
    return results;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
