import type { Config } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { FakeProvider } from './fake.js';
import type { LlmProvider } from './types.js';

export { AnthropicProvider } from './anthropic.js';
export { FakeProvider } from './fake.js';
export type { CompletionRequest, LlmProvider } from './types.js';
export { LlmError } from './types.js';

type Factory = (config: Config) => LlmProvider;

/** Add a provider by writing the class and adding one entry here. */
const FACTORIES: Record<Config['LLM_PROVIDER'], Factory> = {
  anthropic: (config) =>
    new AnthropicProvider({
      // loadConfig() guarantees the key is present for this provider.
      apiKey: config.ANTHROPIC_API_KEY as string,
      model: config.LLM_MODEL,
    }),
  fake: () => new FakeProvider(),
};

export function createLlmProvider(config: Config): LlmProvider {
  const factory = FACTORIES[config.LLM_PROVIDER];
  if (!factory) throw new Error(`Unsupported LLM_PROVIDER: ${config.LLM_PROVIDER}`);
  return factory(config);
}
