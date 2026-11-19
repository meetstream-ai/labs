import { describe, expect, it } from 'vitest';
import { loadConfig, webhookPath, webhookUrl } from '../src/config.js';
import { createLlmProvider } from '../src/llm/index.js';
import { testConfig, WEBHOOK_TOKEN } from './helpers.js';

const BASE = {
  MEETSTREAM_API_KEY: 'test-key',
  PUBLIC_URL: 'https://notetaker.example.invalid',
  WEBHOOK_PATH_TOKEN: WEBHOOK_TOKEN,
  LLM_PROVIDER: 'fake',
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const config = loadConfig(BASE);
    expect(config.MEETSTREAM_BASE_URL).toBe('https://api.meetstream.ai/api/v1');
    expect(config.PORT).toBe(3000);
    // The in-house engine: it is the only provider that needs no external key.
    expect(config.TRANSCRIPT_PROVIDER).toBe('meetstream');
    expect(config.WEBHOOK_TOLERANCE_SECONDS).toBe(300);
    expect(config.WEBHOOK_SIGNING_SECRET).toBeUndefined();
  });

  it('treats keys left blank in a copied .env.example as unset', () => {
    const config = loadConfig({ ...BASE, WEBHOOK_SIGNING_SECRET: '', ANTHROPIC_API_KEY: '' });
    expect(config.WEBHOOK_SIGNING_SECRET).toBeUndefined();
    expect(config.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('fails when the API key is missing', () => {
    const { MEETSTREAM_API_KEY: _omitted, ...rest } = BASE;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/MEETSTREAM_API_KEY/);
  });

  it('rejects a path token short enough to brute force', () => {
    expect(() => loadConfig({ ...BASE, WEBHOOK_PATH_TOKEN: 'short' })).toThrow(
      /WEBHOOK_PATH_TOKEN/,
    );
  });

  it('requires an Anthropic key when that provider is selected', () => {
    expect(() => loadConfig({ ...BASE, LLM_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('strips a trailing slash from PUBLIC_URL so the callback has no double slash', () => {
    const config = loadConfig({ ...BASE, PUBLIC_URL: 'https://notetaker.example.invalid/' });
    expect(webhookUrl(config)).toBe(
      `https://notetaker.example.invalid/webhook/meetstream/${WEBHOOK_TOKEN}`,
    );
  });
});

describe('webhookPath', () => {
  it('embeds the secret token', () => {
    expect(webhookPath(testConfig())).toBe(`/webhook/meetstream/${WEBHOOK_TOKEN}`);
  });
});

describe('createLlmProvider', () => {
  it('builds the provider named in config', () => {
    expect(createLlmProvider(testConfig()).name).toBe('fake');
  });

  it('builds the Anthropic provider without making a request', () => {
    const config = testConfig({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(createLlmProvider(config).name).toBe('anthropic');
  });
});
