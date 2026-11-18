import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../src/llm/anthropic.js';
import { LlmError } from '../src/llm/types.js';

/** Stands in for Anthropic#messages so the test never opens a socket. */
function stubMessages(result: unknown) {
  return {
    create: vi.fn(async () => result),
  } as unknown as { create: ReturnType<typeof vi.fn> };
}

function provider(messages: ReturnType<typeof stubMessages>) {
  return new AnthropicProvider({
    apiKey: 'sk-ant-test',
    model: 'claude-sonnet-5',
    client: messages as never,
  });
}

describe('AnthropicProvider', () => {
  it('maps the request onto the Messages API and joins text blocks', async () => {
    const messages = stubMessages({
      content: [
        { type: 'text', text: '## Summary\n\nShipped.' },
        { type: 'thinking', thinking: 'ignored' },
      ],
    });

    const text = await provider(messages).complete({
      system: 'You are a meeting analyst.',
      prompt: 'Transcript:\n\nAda: Hello.',
    });

    expect(text).toBe('## Summary\n\nShipped.');
    expect(messages.create).toHaveBeenCalledWith({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      temperature: 0,
      system: 'You are a meeting analyst.',
      messages: [{ role: 'user', content: 'Transcript:\n\nAda: Hello.' }],
    });
  });

  it('raises an LlmError when the model returns no text', async () => {
    const messages = stubMessages({ content: [] });
    await expect(provider(messages).complete({ system: 's', prompt: 'p' })).rejects.toThrow(
      LlmError,
    );
  });

  it('wraps a transport failure in an LlmError', async () => {
    const messages = {
      create: vi.fn(async () => {
        throw new Error('connection reset');
      }),
    } as unknown as ReturnType<typeof stubMessages>;

    await expect(provider(messages).complete({ system: 's', prompt: 'p' })).rejects.toThrow(
      LlmError,
    );
  });
});
