import { logger } from '../logger.js';
import type { BotDetails, CreateBotOptions, TranscriptSegment } from './types.js';

/** Injectable so tests can drive the client without touching the network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface MeetStreamClientOptions {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: FetchLike;
}

export class MeetStreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'MeetStreamError';
  }
}

/** Thrown when the transcript exists but is not finished yet (202). */
export class TranscriptNotReadyError extends Error {
  constructor(readonly botId: string) {
    super(`Transcript for ${botId} is not ready yet`);
    this.name = 'TranscriptNotReadyError';
  }
}

export class MeetStreamClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;

  constructor(options: MeetStreamClientOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Token ${this.#apiKey}`);
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');

    const response = await this.#fetch(`${this.#baseUrl}${path}`, { ...init, headers });
    if (!response.ok && response.status !== 202) {
      const body = await response.text().catch(() => '');
      logger.error('MeetStream request failed', { path, status: response.status });
      throw new MeetStreamError(
        `MeetStream ${init.method ?? 'GET'} ${path} failed with ${response.status}`,
        response.status,
        body,
      );
    }
    return response;
  }

  /**
   * Send a bot to a meeting. Audio only — a notetaker never needs video, and video
   * recording is the expensive half of a bot's cost.
   */
  async createBot(options: CreateBotOptions): Promise<string> {
    const body = {
      meeting_link: options.meetingLink,
      bot_name: options.botName,
      video_required: false,
      callback_url: options.callbackUrl,
      custom_attributes: stringifyValues(options.customAttributes ?? {}),
      recording_config: {
        transcript: {
          provider: transcriptProvider(options.transcriptProvider, options.language),
        },
        retention: { type: 'timed', hours: 168 },
      },
      automatic_leave: {
        waiting_room_timeout: 600,
        everyone_left_timeout: 600,
        voice_inactivity_timeout: 600,
        in_call_recording_timeout: 14400,
        recording_permission_denied_timeout: 300,
      },
    };

    const response = await this.#request('/bots/create_bot', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as { bot_id?: string };
    if (!json.bot_id) {
      throw new MeetStreamError('create_bot response had no bot_id', response.status, '');
    }
    return json.bot_id;
  }

  async getBotDetails(botId: string): Promise<BotDetails> {
    const response = await this.#request(`/bots/${encodeURIComponent(botId)}/detail`);
    const json = (await response.json()) as { bot_details?: BotDetails };
    return json.bot_details ?? {};
  }

  /**
   * Stateless fetch: resolve transcript_id from bot detail, then pull the transcript.
   * A 202 means the provider is still working — the caller should retry later.
   */
  async getTranscript(botId: string): Promise<TranscriptSegment[]> {
    const details = await this.getBotDetails(botId);
    if (details.TranscriptStatus === 'Failed') {
      throw new MeetStreamError(`Transcript failed for bot ${botId}`, 200, JSON.stringify(details));
    }
    const transcriptId = details.transcript_id;
    if (!transcriptId) {
      throw new TranscriptNotReadyError(botId);
    }

    const response = await this.#request(
      `/transcript/${encodeURIComponent(transcriptId)}/get_transcript`,
    );
    if (response.status === 202) {
      throw new TranscriptNotReadyError(botId);
    }
    const segments = (await response.json()) as TranscriptSegment[];
    return Array.isArray(segments) ? segments : [];
  }
}

function transcriptProvider(
  provider: CreateBotOptions['transcriptProvider'],
  language: string,
): Record<string, unknown> {
  // `meetstream` needs both language and translate — the API marks them required.
  // deepgram / assemblyai only work when that provider's key is on the account.
  const providers: Record<string, Record<string, unknown>> = {
    deepgram: { deepgram: { model: 'nova-3', language } },
    assemblyai: { assemblyai: { language_code: language } },
    meetstream: { meetstream: { language, translate: false } },
  };
  const selected = providers[provider];
  if (!selected) throw new Error(`Unsupported transcript provider: ${provider}`);
  return selected;
}

function stringifyValues(input: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, String(value)]));
}
