/**
 * The seam for swapping providers. Anything that can turn a system prompt plus a
 * user prompt into text satisfies it, so a new provider is one file plus a case
 * in `createLlmProvider`.
 */
export interface LlmProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<string>;
}

export interface CompletionRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LlmError';
  }
}
