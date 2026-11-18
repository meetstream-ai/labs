import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeProvider } from '../src/llm/fake.js';
import { MeetStreamClient } from '../src/meetstream/client.js';
import type { PipelineResult } from '../src/pipeline.js';
import { createServer } from '../src/webhook/server.js';
import { SAMPLE_TRANSCRIPT, stubFetch, testConfig, WEBHOOK_TOKEN } from './helpers.js';

const PROCESSED_EVENT = {
  event: 'transcription.processed',
  bot_id: 'bot_123',
  timestamp: '2026-11-18T10:00:00Z',
};

let open: Server | undefined;

afterEach(async () => {
  if (!open) return;
  const server = open;
  open = undefined;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function startServer(env: Record<string, string> = {}) {
  const { fetchImpl } = stubFetch({
    'GET /bots/bot_123/detail': { json: { bot_details: { transcript_id: 'tr_9' } } },
    'GET /transcript/tr_9/get_transcript': { json: SAMPLE_TRANSCRIPT },
  });

  const config = testConfig({
    BRIEF_DIR: await mkdtemp(join(tmpdir(), 'notetaker-server-')),
    ...env,
  });

  const processed: PipelineResult[] = [];
  let notify: (() => void) | undefined;

  const app = createServer({
    config,
    client: new MeetStreamClient({
      apiKey: config.MEETSTREAM_API_KEY,
      baseUrl: config.MEETSTREAM_BASE_URL,
      fetchImpl,
    }),
    llm: new FakeProvider(),
    briefDir: config.BRIEF_DIR,
    onProcessed: (result) => {
      processed.push(result);
      notify?.();
    },
  });

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  open = server;

  const { port } = server.address() as AddressInfo;
  return {
    processed,
    url: `http://127.0.0.1:${port}`,
    path: `/webhook/meetstream/${WEBHOOK_TOKEN}`,
    /** Resolves once the async pipeline has reported a result. */
    nextResult: () =>
      new Promise<PipelineResult>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('pipeline did not report')), 5000);
        notify = () => {
          clearTimeout(timer);
          const last = processed.at(-1);
          if (last) resolve(last);
        };
      }),
  };
}

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('webhook server, unsigned per-bot callbacks', () => {
  it('accepts a delivery on the secret path and writes a brief', async () => {
    const server = await startServer();
    const pending = server.nextResult();

    const response = await post(`${server.url}${server.path}`, PROCESSED_EVENT);
    expect(response.status).toBe(200);

    const result = await pending;
    expect(result.status).toBe('written');
  });

  it('404s a wrong path token', async () => {
    const server = await startServer();
    const response = await post(`${server.url}/webhook/meetstream/not-the-token`, PROCESSED_EVENT);
    expect(response.status).toBe(404);
    expect(server.processed).toHaveLength(0);
  });

  it('acknowledges duplicates without reprocessing', async () => {
    const server = await startServer();
    const pending = server.nextResult();
    await post(`${server.url}${server.path}`, PROCESSED_EVENT);
    await pending;

    const duplicate = await post(`${server.url}${server.path}`, PROCESSED_EVENT);
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toEqual({ status: 'duplicate' });
    expect(server.processed).toHaveLength(1);
  });

  it('rejects a malformed payload', async () => {
    const server = await startServer();
    const response = await post(`${server.url}${server.path}`, { event: 42 });
    expect(response.status).toBe(400);
  });

  it('answers the health check', async () => {
    const server = await startServer();
    const response = await fetch(`${server.url}/healthz`);
    expect(response.status).toBe(200);
  });
});

describe('webhook server, signed workspace endpoint', () => {
  const secret = 'whsec_workspace';

  /** Mirrors a real workspace delivery: HMAC over the raw body, ISO timestamp. */
  function signedHeaders(rawBody: string, timestampMs = Date.now()) {
    return {
      'x-meetstream-timestamp': new Date(timestampMs).toISOString(),
      'x-meetstream-signature': `sha256=${createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex')}`,
    };
  }

  it('accepts a correctly signed delivery', async () => {
    const server = await startServer({ WEBHOOK_SIGNING_SECRET: secret });
    const rawBody = JSON.stringify(PROCESSED_EVENT);
    const pending = server.nextResult();

    const response = await post(`${server.url}${server.path}`, rawBody, signedHeaders(rawBody));
    expect(response.status).toBe(200);
    await expect(pending).resolves.toMatchObject({ status: 'written' });
  });

  it('401s an unsigned delivery once a signing secret is configured', async () => {
    const server = await startServer({ WEBHOOK_SIGNING_SECRET: secret });
    const response = await post(`${server.url}${server.path}`, PROCESSED_EVENT);
    expect(response.status).toBe(401);
    expect(server.processed).toHaveLength(0);
  });

  it('401s a tampered body whose signature covers the original', async () => {
    const server = await startServer({ WEBHOOK_SIGNING_SECRET: secret });
    const rawBody = JSON.stringify(PROCESSED_EVENT);
    const headers = signedHeaders(rawBody);
    const tampered = JSON.stringify({ ...PROCESSED_EVENT, bot_id: 'bot_attacker' });

    const response = await post(`${server.url}${server.path}`, tampered, headers);
    expect(response.status).toBe(401);
    expect(server.processed).toHaveLength(0);
  });

  it('401s a replayed delivery from outside the tolerance window', async () => {
    const server = await startServer({ WEBHOOK_SIGNING_SECRET: secret });
    const rawBody = JSON.stringify(PROCESSED_EVENT);
    const stale = signedHeaders(rawBody, Date.now() - 600_000);

    const response = await post(`${server.url}${server.path}`, rawBody, stale);
    expect(response.status).toBe(401);
    expect(server.processed).toHaveLength(0);
  });
});
