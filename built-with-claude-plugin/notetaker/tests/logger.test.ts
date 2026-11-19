import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger, setLogLevel } from '../src/logger.js';

function captureStderr() {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, spy };
}

afterEach(() => {
  setLogLevel('info');
});

describe('logger', () => {
  it('keeps its own message when the context carries a "message" field', () => {
    const { lines } = captureStderr();
    // Webhook payloads have a `message` field; logging one must not overwrite ours.
    logger.error('Transcription failed', { botId: 'bot_1', detail: 'provider error' });

    const entry = JSON.parse(lines[0]!);
    expect(entry.message).toBe('Transcription failed');
    expect(entry.detail).toBe('provider error');
    expect(entry.level).toBe('error');
  });

  it('suppresses entries below the configured level', () => {
    const { lines } = captureStderr();
    setLogLevel('error');
    logger.warn('not emitted');
    expect(lines).toHaveLength(0);
  });
});
