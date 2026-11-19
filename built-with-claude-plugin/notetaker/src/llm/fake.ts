import type { CompletionRequest, LlmProvider } from './types.js';

/**
 * Deterministic provider for tests and for running the pipeline end to end
 * without an LLM key. Records what it was asked so tests can assert on prompts.
 */
export class FakeProvider implements LlmProvider {
  readonly name = 'fake';
  readonly requests: CompletionRequest[] = [];

  constructor(private readonly response: string = DEFAULT_RESPONSE) {}

  async complete(request: CompletionRequest): Promise<string> {
    this.requests.push(request);
    return this.response;
  }
}

const DEFAULT_RESPONSE = `## Summary

The team reviewed the rollout and agreed on a date.

## Decisions

- Ship on Friday.

## Action Items

- **Ada** — publish the changelog (Thursday)
`;
