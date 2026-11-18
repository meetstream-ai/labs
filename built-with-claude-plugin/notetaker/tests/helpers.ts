import { loadConfig, type Config } from '../src/config.js';
import type { FetchLike } from '../src/meetstream/client.js';
import type { TranscriptSegment } from '../src/meetstream/types.js';

export const WEBHOOK_TOKEN = 'test_token_0123456789';

/** A complete, valid config that never points at anything real. */
export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    MEETSTREAM_API_KEY: 'test-key',
    MEETSTREAM_BASE_URL: 'https://api.example.invalid/api/v1',
    PUBLIC_URL: 'https://notetaker.example.invalid',
    WEBHOOK_PATH_TOKEN: WEBHOOK_TOKEN,
    LLM_PROVIDER: 'fake',
    BRIEF_DIR: './briefs',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export interface RecordedRequest {
  url: string;
  init: RequestInit | undefined;
}

export interface StubRoute {
  status?: number;
  json?: unknown;
  body?: string;
}

/**
 * A fetch stub keyed by "METHOD /path-suffix". Any unmatched request throws, so a
 * test can never silently reach the network.
 */
export function stubFetch(routes: Record<string, StubRoute>): {
  fetchImpl: FetchLike;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];

  const fetchImpl: FetchLike = async (url, init) => {
    requests.push({ url, init });
    const method = (init?.method ?? 'GET').toUpperCase();
    const match = Object.entries(routes).find(([key]) => {
      const [routeMethod, routePath] = key.split(' ');
      return routeMethod === method && routePath !== undefined && url.includes(routePath);
    });

    if (!match) throw new Error(`Unexpected request: ${method} ${url}`);
    const route = match[1];
    const body = route.body ?? JSON.stringify(route.json ?? {});
    return new Response(body, {
      status: route.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  return { fetchImpl, requests };
}

export const SAMPLE_TRANSCRIPT: TranscriptSegment[] = [
  { speaker: 'Ada', transcript: 'We need to pick a ship date.' },
  { speaker: 'Grace', transcript: 'Friday works if the changelog is ready.' },
  { speaker: 'Ada', transcript: "I'll publish the changelog on Thursday." },
];
