import { randomUUID } from 'node:crypto';

/**
 * The two MeetStream calls this template needs.
 *
 * Auth header is `Token <key>`, not `Bearer`.
 * Errors arrive as { "message": "..." }.
 */
export class MeetStream {
  constructor({ apiKey, baseUrl = 'https://api.meetstream.ai/api/v1' }) {
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

    // 507 = you replayed an Idempotency-Key. The original call succeeded.
    if (res.status === 507) return { status: 507, replay: true, data };
    if (!res.ok) {
      const err = new Error(data?.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return { status: res.status, replay: false, data };
  }

  /**
   * POST /bots/create_bot
   *
   * `callback_url` is set per bot. There is no account-wide webhook setting, so
   * a bot created without callback_url produces no webhooks at all.
   */
  createBot({ meetingLink, botName, callbackUrl, videoRequired = false, idempotencyKey = randomUUID() }) {
    return this.#request('POST', '/bots/create_bot', {
      headers: { 'Idempotency-Key': idempotencyKey },
      body: {
        meeting_link: meetingLink,
        bot_name: botName,
        video_required: videoRequired,
        callback_url: callbackUrl,
        custom_attributes: { template: 'webhook-local-tunnel' },
        recording_config: {
          transcript: { provider: { deepgram: { model: 'nova-3', language: 'en' } } },
        },
        automatic_leave: {
          waiting_room_timeout: 300,
          everyone_left_timeout: 60,
          // Minimum accepted value is 600. Lower values are rejected with 400.
          in_call_recording_timeout: 3600,
        },
      },
    });
  }

  /** GET /bots/{id}/remove_bot  (a GET, not a POST or DELETE) */
  removeBot(botId) {
    return this.#request('GET', `/bots/${botId}/remove_bot`);
  }
}
