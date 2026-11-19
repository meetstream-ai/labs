import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeProvider } from '../src/llm/fake.js';
import { MeetStreamClient } from '../src/meetstream/client.js';
import { handleEvent } from '../src/pipeline.js';
import { Deduplicator, dedupeKey } from '../src/webhook/dedupe.js';
import { isJoinFailure } from '../src/webhook/events.js';
import { SAMPLE_TRANSCRIPT, stubFetch } from './helpers.js';

async function pipelineOptions() {
  const { fetchImpl } = stubFetch({
    'GET /bots/bot_123/detail': {
      json: {
        bot_details: {
          transcript_id: 'tr_9',
          MeetingLink: 'https://meet.google.com/abc-defg-hij',
        },
      },
    },
    'GET /transcript/tr_9/get_transcript': { json: SAMPLE_TRANSCRIPT },
  });

  return {
    client: new MeetStreamClient({
      apiKey: 'test-key',
      baseUrl: 'https://api.example.invalid/api/v1',
      fetchImpl,
    }),
    llm: new FakeProvider(),
    briefDir: await mkdtemp(join(tmpdir(), 'notetaker-pipeline-')),
  };
}

describe('handleEvent', () => {
  it('writes a brief on transcription.processed', async () => {
    const options = await pipelineOptions();
    const result = await handleEvent(
      { event: 'transcription.processed', bot_id: 'bot_123', timestamp: '2026-11-18T10:00:00Z' },
      options,
    );

    expect(result.status).toBe('written');
    if (result.status !== 'written') throw new Error('expected a written brief');

    const contents = await readFile(result.path, 'utf8');
    expect(contents).toContain('# Meeting Brief');
    expect(contents).toContain('- Meeting: https://meet.google.com/abc-defg-hij');
    expect(contents).toContain('## Action Items');
  });

  it('ignores lifecycle events that carry no transcript', async () => {
    const options = await pipelineOptions();
    for (const event of ['bot.joining', 'bot.recording', 'audio.processed', 'bot.done']) {
      const result = await handleEvent({ event, bot_id: 'bot_123' }, options);
      expect(result).toEqual({ status: 'ignored', reason: event });
    }
    expect(options.llm.requests).toHaveLength(0);
  });

  it('treats a clean bot.stopped as nothing to do', async () => {
    const options = await pipelineOptions();
    const result = await handleEvent(
      { event: 'bot.stopped', bot_event: 'bot.stopped', bot_id: 'bot_123', status_code: 200 },
      options,
    );
    expect(result).toEqual({ status: 'ignored', reason: 'bot.stopped' });
  });

  it('reports failure when the bot was never admitted', async () => {
    const options = await pipelineOptions();
    const result = await handleEvent(
      {
        event: 'bot.stopped',
        bot_event: 'bot.notallowed',
        bot_id: 'bot_123',
        bot_status: 'NotAllowed',
        status_code: 500,
      },
      options,
    );
    expect(result).toEqual({ status: 'failed', reason: 'bot.notallowed', botId: 'bot_123' });
  });

  it('reports failure on transcription.failed', async () => {
    const options = await pipelineOptions();
    const result = await handleEvent(
      { event: 'transcription.failed', bot_id: 'bot_123', message: 'provider error' },
      options,
    );
    expect(result).toEqual({ status: 'failed', reason: 'provider error', botId: 'bot_123' });
  });
});

describe('isJoinFailure', () => {
  it('distinguishes a kick from a failure to join', () => {
    // A kicked bot still recorded, and reports bot_status "Stopped" with a 200.
    expect(isJoinFailure({ event: 'bot.stopped', bot_event: 'bot.kicked' })).toBe(false);
    expect(isJoinFailure({ event: 'bot.stopped', bot_event: 'bot.denied' })).toBe(true);
  });
});

describe('Deduplicator', () => {
  it('claims a key once', () => {
    const deduplicator = new Deduplicator();
    const key = dedupeKey({
      bot_id: 'bot_1',
      event: 'transcription.processed',
      timestamp: '2026-11-18T10:00:00Z',
    });
    expect(deduplicator.claim(key)).toBe(true);
    expect(deduplicator.claim(key)).toBe(false);
  });

  it('separates events that differ only by bot_event', () => {
    const deduplicator = new Deduplicator();
    const base = { bot_id: 'bot_1', event: 'bot.stopped', timestamp: '2026-11-18T10:00:00Z' };
    expect(deduplicator.claim(dedupeKey({ ...base, bot_event: 'bot.stopped' }))).toBe(true);
    expect(deduplicator.claim(dedupeKey({ ...base, bot_event: 'bot.kicked' }))).toBe(true);
  });

  it('evicts the oldest keys past its bound', () => {
    const deduplicator = new Deduplicator(2);
    expect(deduplicator.claim('a')).toBe(true);
    expect(deduplicator.claim('b')).toBe(true);
    expect(deduplicator.claim('c')).toBe(true);
    // "a" was evicted, so it is claimable again; "c" is still remembered.
    expect(deduplicator.claim('a')).toBe(true);
    expect(deduplicator.claim('c')).toBe(false);
  });
});
