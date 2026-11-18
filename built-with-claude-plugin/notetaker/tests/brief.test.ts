import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatTranscript, generateBrief, SYSTEM_PROMPT } from '../src/brief/generate.js';
import { briefFilename, renderBrief, writeBrief } from '../src/brief/render.js';
import { FakeProvider } from '../src/llm/fake.js';
import { SAMPLE_TRANSCRIPT } from './helpers.js';

describe('formatTranscript', () => {
  it('renders one speaker-prefixed line per segment', () => {
    expect(formatTranscript(SAMPLE_TRANSCRIPT)).toBe(
      [
        'Ada: We need to pick a ship date.',
        'Grace: Friday works if the changelog is ready.',
        "Ada: I'll publish the changelog on Thursday.",
      ].join('\n'),
    );
  });

  it('drops segments with no words', () => {
    const formatted = formatTranscript([
      { speaker: 'Ada', transcript: 'Hello.' },
      { speaker: 'Grace', transcript: '' },
    ]);
    expect(formatted).toBe('Ada: Hello.');
  });
});

describe('generateBrief', () => {
  it('asks the provider for the four required sections', async () => {
    const llm = new FakeProvider();
    const brief = await generateBrief({ segments: SAMPLE_TRANSCRIPT, llm });

    expect(llm.requests).toHaveLength(1);
    const request = llm.requests[0]!;
    expect(request.system).toBe(SYSTEM_PROMPT);
    expect(request.system).toContain('## Decisions');
    expect(request.system).toContain('## Action Items');
    expect(request.prompt).toContain('Ada: We need to pick a ship date.');
    expect(brief).toContain('## Summary');
  });

  it('includes the meeting link when there is one', async () => {
    const llm = new FakeProvider();
    await generateBrief({
      segments: SAMPLE_TRANSCRIPT,
      llm,
      meetingLink: 'https://meet.google.com/abc-defg-hij',
    });
    expect(llm.requests[0]!.prompt).toContain('https://meet.google.com/abc-defg-hij');
  });

  it('refuses to call the model on an empty transcript', async () => {
    const llm = new FakeProvider();
    await expect(generateBrief({ segments: [], llm })).rejects.toThrow('Transcript is empty');
    expect(llm.requests).toHaveLength(0);
  });
});

describe('renderBrief', () => {
  const generatedAt = new Date('2026-11-18T10:30:00.000Z');

  it('prefixes the model output with meeting metadata', () => {
    const markdown = renderBrief({
      botId: 'bot_123',
      body: '## Summary\n\nShipped.',
      meetingLink: 'https://meet.google.com/abc-defg-hij',
      generatedAt,
    });

    expect(markdown).toContain('# Meeting Brief');
    expect(markdown).toContain('- Bot: `bot_123`');
    expect(markdown).toContain('- Meeting: https://meet.google.com/abc-defg-hij');
    expect(markdown).toContain('- Generated: 2026-11-18T10:30:00.000Z');
    // Blank line after the rule, so the first heading still parses as a heading.
    expect(markdown).toContain('---\n\n## Summary');
    expect(markdown.trimEnd().endsWith('Shipped.')).toBe(true);
  });

  it('omits the meeting line when the link is unknown', () => {
    const markdown = renderBrief({ botId: 'bot_123', body: 'x', generatedAt });
    expect(markdown).not.toContain('- Meeting:');
  });

  it('builds a filesystem-safe filename', () => {
    expect(briefFilename('bot/../123', generatedAt)).toBe('2026-11-18-bot____123.md');
  });
});

describe('writeBrief', () => {
  it('creates the directory and writes the markdown', async () => {
    const directory = join(await mkdtemp(join(tmpdir(), 'notetaker-')), 'nested');
    const { path, contents } = await writeBrief(directory, {
      botId: 'bot_123',
      body: '## Summary\n\nShipped.',
      generatedAt: new Date('2026-11-18T10:30:00.000Z'),
    });

    expect(path.endsWith('2026-11-18-bot_123.md')).toBe(true);
    await expect(readFile(path, 'utf8')).resolves.toBe(contents);
  });
});
