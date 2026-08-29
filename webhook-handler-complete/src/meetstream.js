import { randomUUID } from 'node:crypto';
import { STREAMING_PROVIDERS } from './config.js';

/**
 * Minimal MeetStream client, only what this template needs.
 *
 * Auth header is literally `Token <key>`, not `Bearer`.
 * Errors come back as { "message": "..." }.
 */
export class MeetStream {
  constructor({ apiKey, baseUrl }) {
    if (!apiKey) throw new Error('MEETSTREAM_API_KEY is required');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async #request(method, path, { body, headers = {} } = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Token ${this.apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { message: text };
    }

    // 507 means "you already sent this exact Idempotency-Key". The original
    // request succeeded, so this is a SUCCESS, not an error.
    if (res.status === 507) {
      return { ok: true, status: 507, replay: true, data };
    }
    if (!res.ok) {
      const err = new Error(data?.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return { ok: true, status: res.status, replay: false, data };
  }

  /**
   * POST /bots/create_bot
   * `callback_url` is per-bot. There is no global webhook endpoint: every bot
   * you want events for must carry its own callback_url.
   */
  async createBot({
    meetingLink,
    botName,
    callbackUrl,
    videoRequired = false,
    provider = 'deepgram',
    customAttributes = {},
    idempotencyKey = randomUUID(),
  }) {
    const body = {
      meeting_link: meetingLink,
      bot_name: botName,
      video_required: videoRequired,
      callback_url: callbackUrl,
      custom_attributes: customAttributes,
      recording_config: {
        transcript: { provider: { [provider]: providerDefaults(provider) } },
      },
      automatic_leave: {
        waiting_room_timeout: 300,
        everyone_left_timeout: 60,
        // in_call_recording_timeout has a hard minimum of 600. Below that the
        // API rejects the whole request with HTTP 400.
        in_call_recording_timeout: 3600,
      },
    };

    return this.#request('POST', '/bots/create_bot', {
      body,
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  }

  /** GET /bots/{id}/remove_bot  (yes, GET) */
  removeBot(botId) {
    return this.#request('GET', `/bots/${botId}/remove_bot`);
  }

  /** GET /bots/{id}/detail  - this is where transcript_id lives after creation */
  botDetail(botId) {
    return this.#request('GET', `/bots/${botId}/detail`);
  }
}

function providerDefaults(provider) {
  switch (provider) {
    case 'deepgram':
      return { model: 'nova-3', language: 'en' };
    case 'deepgram_streaming':
      return { model: 'nova-3', language: 'en' };
    case 'assemblyai':
    case 'assemblyai_streaming':
      return { language_code: 'en' };
    default:
      // sarvam, jigsawstack, meetstream, meeting_captions and their streaming
      // variants take no required options.
      return {};
  }
}

export function isStreamingProvider(provider) {
  return STREAMING_PROVIDERS.has(provider);
}
