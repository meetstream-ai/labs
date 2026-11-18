import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../logger.js';
import { LlmError, type CompletionRequest, type LlmProvider } from './types.js';

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  client?: Pick<Anthropic['messages'], 'create'>;
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly #messages: Pick<Anthropic['messages'], 'create'>;
  readonly #model: string;

  constructor(options: AnthropicProviderOptions) {
    this.#model = options.model;
    this.#messages = options.client ?? new Anthropic({ apiKey: options.apiKey }).messages;
  }

  async complete(request: CompletionRequest): Promise<string> {
    try {
      const response = await this.#messages.create({
        model: this.#model,
        max_tokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0,
        system: request.system,
        messages: [{ role: 'user', content: request.prompt }],
      });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim();

      if (!text) throw new LlmError('Model returned no text content', this.name);
      return text;
    } catch (error) {
      if (error instanceof LlmError) throw error;
      logger.error('Anthropic completion failed', { model: this.#model });
      throw new LlmError('Anthropic completion failed', this.name, error);
    }
  }
}
