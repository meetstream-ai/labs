import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * A deterministic stand-in for `fetch`, so the template is runnable without an
 * API key and without creating (or paying for) 50 real bots.
 *
 * It reproduces four real behaviours:
 *
 *   201  a fresh Idempotency-Key creates a bot
 *   507  a REPEATED Idempotency-Key replays the original result
 *   409  a different key targeting a meeting_link that already has a bot
 *   503  a transient server error on the first attempt for some jobs, so you
 *        can watch the retry wrapper work
 *
 * Bodies match the real response shapes:
 *   create ok -> { bot_id, transcript_id, meeting_url, status }
 *   error     -> { message }
 */
export function createSimulatedTransport({ transientRate = 5, statePath = null } = {}) {
  /** Idempotency-Key -> the response body of the original successful call. */
  const byKey = new Map();
  /** meeting_link -> bot_id, for the 409 dedup rule. */
  const byMeeting = new Map();
  /** Idempotency-Key -> how many times we have already failed it transiently. */
  const transientBudget = new Map();

  // Persist across runs so that re-running the same batch id genuinely
  // produces 507 replays, exactly as the real API would.
  if (statePath && existsSync(statePath)) {
    try {
      const saved = JSON.parse(readFileSync(statePath, 'utf8'));
      for (const [k, v] of Object.entries(saved.byKey ?? {})) byKey.set(k, v);
      for (const [k, v] of Object.entries(saved.byMeeting ?? {})) byMeeting.set(k, v);
    } catch {
      // A corrupt simulation state file is not worth failing over.
    }
  }

  const persist = () => {
    if (!statePath) return;
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify(
        { byKey: Object.fromEntries(byKey), byMeeting: Object.fromEntries(byMeeting) },
        null,
        2,
      ),
      'utf8',
    );
  };

  const json = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });

  const fetchImpl = async (url, init = {}) => {
    // Network latency, so concurrency limits are actually observable.
    await new Promise((r) => setTimeout(r, 120 + Math.random() * 260));

    if (!String(url).endsWith('/bots/create_bot')) {
      return json(404, { message: 'Simulated transport only implements create_bot.' });
    }

    const headers = init.headers ?? {};
    const key = headers['Idempotency-Key'];
    const payload = JSON.parse(init.body);
    const meetingLink = payload.meeting_link;
    const jobId = payload.custom_attributes?.batch_job_id ?? 'unknown';

    if (!key) return json(400, { message: 'Idempotency-Key header is required in this simulation.' });

    // Replay: this exact key already succeeded.
    if (byKey.has(key)) return json(507, byKey.get(key));

    // Transient failure on the first attempt for a deterministic slice of jobs.
    const bucket = Number.parseInt(createHash('sha1').update(jobId).digest('hex').slice(0, 4), 16);
    if (bucket % transientRate === 0) {
      const used = transientBudget.get(key) ?? 0;
      if (used < 1) {
        transientBudget.set(key, used + 1);
        return json(503, { message: 'Service temporarily unavailable.' });
      }
    }

    // Dedup: a bot already exists for this meeting, under a different key.
    if (byMeeting.has(meetingLink)) {
      return json(409, { message: 'A bot has already been created for this meeting link.' });
    }

    const botId = `bot_${createHash('sha1').update(key).digest('hex').slice(0, 12)}`;
    const streamingOnly = payload.custom_attributes?.streaming_only === 'true';
    const body = {
      bot_id: botId,
      // transcript_id is null for meeting_captions and for streaming-only runs.
      transcript_id: streamingOnly ? null : `tr_${createHash('sha1').update(botId).digest('hex').slice(0, 12)}`,
      meeting_url: meetingLink,
      status: 'joining',
    };

    byKey.set(key, body);
    byMeeting.set(meetingLink, botId);
    persist();
    return json(201, body);
  };

  return { fetchImpl, byKey, byMeeting, persist };
}
