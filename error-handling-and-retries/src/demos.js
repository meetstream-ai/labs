import { MeetStreamClient } from './client.js';
import { MeetStreamError, explain } from './errors.js';
import { pollUntilReady, PollTimeoutError } from './poll.js';
import { mockTransport, responses, flakyThenOk } from './mock-transport.js';
import { log } from './logger.js';

/**
 * Every branch of the error surface, demonstrated end to end.
 *
 * Offline demos use src/mock-transport.js so they are deterministic and free.
 * Live demos hit the real API and only exercise cases that cost nothing and
 * create nothing: 401, 403, a 400 validation failure, and a 404.
 */

const VALID_BOT = {
  meeting_link: 'https://meet.google.com/abc-defg-hij',
  bot_name: 'Retry Demo Bot',
  video_required: false,
  recording_config: {
    transcript: { provider: { deepgram: { model: 'nova-3', language: 'en' } } },
  },
};

/** Retry settings tuned for a readable demo, not for production. */
const FAST_RETRY = { maxAttempts: 5, baseDelayMs: 120, maxDelayMs: 800, maxElapsedMs: 15_000 };

const onRetry = (info) =>
  log.warn(
    `retry ${info.attempt}/${info.maxAttempts} in ${info.delayMs}ms` +
      `${info.honoredRetryAfter ? ' (Retry-After honored)' : ' (exponential backoff + jitter)'}` +
      ` after ${info.status ?? 'network error'}: ${info.message}`,
  );

function client(spec, extra = {}) {
  const { fetchImpl, state } = mockTransport(spec);
  return {
    state,
    api: new MeetStreamClient({
      apiKey: 'demo-key',
      fetchImpl,
      retry: FAST_RETRY,
      onRetry,
      ...extra,
    }),
  };
}

// ---------------------------------------------------------------------------
// Offline demos
// ---------------------------------------------------------------------------

export const offlineDemos = [
  {
    name: '400 validation - missing required field',
    async run() {
      const { api, state } = client({ respond: () => responses.missingMeetingLink() });
      try {
        // Deliberately omitting meeting_link.
        await api.createBot({ bot_name: 'No link' });
        return fail('expected a 400');
      } catch (err) {
        assertStatus(err, 400);
        log.detail('api message', `"${err.message}"`);
        log.detail('retryable', String(err.retryable));
        log.detail('attempts made', String(state.calls));
        return pass(
          'Surfaced the API message verbatim and did NOT retry. Identical input will fail identically forever.',
        );
      }
    },
  },

  {
    name: '400 validation - in_call_recording_timeout below the 600s floor',
    async run() {
      const { api } = client({ respond: () => responses.timeoutTooLow() });
      try {
        await api.createBot({ ...VALID_BOT, automatic_leave: { in_call_recording_timeout: 300 } });
        return fail('expected a 400');
      } catch (err) {
        assertStatus(err, 400);
        log.detail('api message', `"${err.message}"`);
        return pass('600 seconds is a hard minimum. Anything lower rejects the whole request.');
      }
    },
  },

  {
    name: '401 vs 403 - missing key vs invalid key',
    async run() {
      const noKey = new MeetStreamClient({
        apiKey: null,
        fetchImpl: mockTransport({ respond: () => responses.noCredentials() }).fetchImpl,
        retry: FAST_RETRY,
      });
      const badKey = new MeetStreamClient({
        apiKey: 'not-a-real-key',
        fetchImpl: mockTransport({ respond: () => responses.invalidToken() }).fetchImpl,
        retry: FAST_RETRY,
      });

      let a;
      let b;
      try {
        await noKey.botStatus('bot_1');
      } catch (err) {
        a = err;
      }
      try {
        await badKey.botStatus('bot_1');
      } catch (err) {
        b = err;
      }

      assertStatus(a, 401);
      assertStatus(b, 403);
      log.detail('401', `"${a.message}" - no Authorization header was sent`);
      log.detail('403', `"${b.message}" - a header was sent but the key is not valid`);
      return pass(
        'A 401 usually means your env var is empty or you wrote `Bearer` instead of `Token`. A 403 means the key itself is wrong.',
      );
    },
  },

  {
    name: '404 - unknown bot id',
    async run() {
      const { api, state } = client({ respond: () => responses.notFound() });
      try {
        await api.botStatus('bot_does_not_exist');
        return fail('expected a 404');
      } catch (err) {
        assertStatus(err, 404);
        log.detail('api message', `"${err.message}"`);
        log.detail('attempts made', String(state.calls));
        return pass('Not retried. Usually a bot from another environment, or one already deleted.');
      }
    },
  },

  {
    name: '409 - deduplication conflict',
    async run() {
      const { api, state } = client({ respond: () => responses.duplicateBot() });
      try {
        await api.createBot(VALID_BOT);
        return fail('expected a 409');
      } catch (err) {
        assertStatus(err, 409);
        log.detail('api message', `"${err.message}"`);
        log.detail('attempts made', String(state.calls));
        log.detail('do this instead', 'GET /bots to find the existing bot and reuse its bot_id');
        return pass('A conflict is a permanent answer for this payload, so it is not retried.');
      }
    },
  },

  {
    name: '429 - rate limited, Retry-After honored',
    async run() {
      const { api, state } = client(
        flakyThenOk(2, () => responses.rateLimited(1), () => responses.botCreated()),
      );
      const started = Date.now();
      const res = await api.createBot(VALID_BOT);
      const elapsed = Date.now() - started;

      log.detail('http calls', String(state.calls));
      log.detail('final status', String(res.status));
      log.detail('elapsed', `${elapsed}ms`);
      if (elapsed < 2000) return fail('Retry-After was not actually honored');
      return pass(
        'Two 429s with `Retry-After: 1`, so the client waited ~1s each time instead of using its own curve.',
      );
    },
  },

  {
    name: '500 / 503 - exponential backoff with jitter',
    async run() {
      let sequence = 0;
      const { api, state } = client({
        respond: () => {
          sequence += 1;
          if (sequence === 1) return responses.unavailable(); // 503, no Retry-After
          if (sequence === 2) return responses.serverError(); // 500
          return responses.botCreated();
        },
      });
      const res = await api.createBot(VALID_BOT);
      log.detail('http calls', String(state.calls));
      log.detail('final status', String(res.status));
      log.detail('bot_id', res.data.bot_id);
      return pass(
        'Transient server errors are retried on an exponential curve with full jitter, so a fleet of clients does not resynchronize.',
      );
    },
  },

  {
    name: '507 - idempotent replay is a SUCCESS',
    async run() {
      const { api, state } = client({ respond: () => responses.idempotentReplay('bot_abc123') });
      // No try/catch: a 507 must not throw.
      const res = await api.createBot(VALID_BOT, { idempotencyKey: 'fixed-key-for-this-job' });

      if (res.status !== 507) return fail(`expected status 507, got ${res.status}`);
      if (!res.replay) return fail('expected replay: true');

      const sentKey = state.requests[0].headers['Idempotency-Key'];
      log.detail('status', '507');
      log.detail('replay', 'true');
      log.detail('Idempotency-Key sent', sentKey);
      log.detail('bot_id returned', res.data.bot_id);
      return pass(
        'The original request already created bot_abc123. Treating 507 as an error would double-create on retry or fake an outage.',
      );
    },
  },

  {
    name: '202 - polling until ready, with a cap',
    async run() {
      let calls = 0;
      const { api } = client({
        respond: () => {
          calls += 1;
          return calls < 3 ? responses.pending() : responses.transcriptReady();
        },
      });

      const result = await pollUntilReady(() => api.getTranscript('tr_live_001'), {
        maxAttempts: 6,
        intervalMs: 100,
        maxIntervalMs: 400,
        maxElapsedMs: 5_000,
        label: 'transcript tr_live_001',
        onPending: (i) => log.info(`  202 not ready, poll ${i.attempt}/${i.maxAttempts}, waiting ${i.waitMs}ms`),
      });

      const segments = result.data.transcript;
      log.detail('polls', String(result.attempts));
      log.detail('segments', String(segments.length));
      log.detail('first segment', `${segments[0].speaker}: "${segments[0].transcript}"`);
      return pass('202 is not an error. Poll it, and read the `transcript` field (not `text`).');
    },
  },

  {
    name: '202 forever - streaming-only bot, capped instead of hanging',
    async run() {
      const { api } = client({ respond: () => responses.pending() });
      try {
        await pollUntilReady(() => api.getTranscript('tr_streaming_only'), {
          maxAttempts: 4,
          intervalMs: 80,
          maxIntervalMs: 200,
          maxElapsedMs: 3_000,
          label: 'transcript tr_streaming_only',
        });
        return fail('expected the poll to be capped');
      } catch (err) {
        if (!(err instanceof PollTimeoutError)) throw err;
        log.detail('attempts', String(err.attempts));
        log.detail('gave up after', `${err.elapsedMs}ms`);
        return pass(
          'Streaming-only providers never produce a post-call transcript, so 202 is the permanent answer. An uncapped poll here hangs the worker forever.',
        );
      }
    },
  },

  {
    name: 'Retry budget - a permanent 500 does not retry until the heat death of the universe',
    async run() {
      const { api, state } = client({ respond: () => responses.serverError() });
      try {
        await api.createBot(VALID_BOT, {
          retry: { maxAttempts: 8, baseDelayMs: 100, maxDelayMs: 400, maxElapsedMs: 600 },
        });
        return fail('expected the retry budget to be exhausted');
      } catch (err) {
        log.detail('http calls', String(state.calls));
        log.detail('error', err.message);
        return pass('Capped by wall clock, not just attempt count. Both caps matter.');
      }
    },
  },
];

// ---------------------------------------------------------------------------
// Live demos: real API, no resources created, no cost
// ---------------------------------------------------------------------------

export const liveDemos = [
  {
    name: 'LIVE 401 - no API key sent',
    needsKey: false,
    async run({ baseUrl }) {
      const api = new MeetStreamClient({ apiKey: null, baseUrl, retry: { maxAttempts: 1 } });
      try {
        await api.request('GET', '/bots');
        return fail('expected a 401');
      } catch (err) {
        log.detail('status', String(err.status));
        log.detail('message', `"${err.message}"`);
        return err.status === 401
          ? pass('No Authorization header at all gives 401.')
          : fail(`expected 401, got ${err.status}`);
      }
    },
  },

  {
    name: 'LIVE 403 - key present but invalid',
    needsKey: false,
    async run({ baseUrl }) {
      const api = new MeetStreamClient({
        apiKey: 'definitely-not-a-valid-key',
        baseUrl,
        retry: { maxAttempts: 1 },
      });
      try {
        await api.request('GET', '/bots');
        return fail('expected a 403');
      } catch (err) {
        log.detail('status', String(err.status));
        log.detail('message', `"${err.message}"`);
        return err.status === 403
          ? pass('A syntactically fine but wrong key gives 403, not 401.')
          : fail(`expected 403, got ${err.status}`);
      }
    },
  },

  {
    name: 'LIVE 400 - create_bot with no meeting_link (creates nothing)',
    needsKey: true,
    async run({ baseUrl, apiKey }) {
      const api = new MeetStreamClient({ apiKey, baseUrl, retry: { maxAttempts: 1 } });
      try {
        await api.createBot({ bot_name: 'Validation probe, will not be created' });
        return fail('expected a 400');
      } catch (err) {
        log.detail('status', String(err.status));
        log.detail('message', `"${err.message}"`);
        return err.status === 400
          ? pass('Validation rejects before anything is created. Nothing was spent.')
          : fail(`expected 400, got ${err.status}`);
      }
    },
  },

  {
    name: 'LIVE 404 - status of a bot id that does not exist',
    needsKey: true,
    async run({ baseUrl, apiKey }) {
      const api = new MeetStreamClient({ apiKey, baseUrl, retry: { maxAttempts: 1 } });
      try {
        await api.botStatus('00000000-0000-0000-0000-000000000000');
        return fail('expected a 404');
      } catch (err) {
        log.detail('status', String(err.status));
        log.detail('message', `"${err.message}"`);
        return [404, 400].includes(err.status)
          ? pass(`Unknown id rejected with ${err.status}. ${explain(err.status)}`)
          : fail(`expected 404, got ${err.status}`);
      }
    },
  },
];

// ---------------------------------------------------------------------------

function pass(note) {
  return { ok: true, note };
}
function fail(note) {
  return { ok: false, note };
}
function assertStatus(err, status) {
  if (!(err instanceof MeetStreamError)) {
    throw new Error(`expected a MeetStreamError, got ${err?.name}: ${err?.message}`);
  }
  if (err.status !== status) {
    throw new Error(`expected status ${status}, got ${err.status}`);
  }
}
