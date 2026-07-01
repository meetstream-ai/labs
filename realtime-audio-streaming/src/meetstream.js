/**
 * MeetStream API client
 * Wraps the REST endpoints documented at docs.meetstream.ai
 *
 * API base: https://api.meetstream.ai/api/v1
 * Auth:     Authorization: Token YOUR_API_KEY
 */

const BASE_URL = "https://api.meetstream.ai/api/v1";

// Retry tuning — generous enough to survive transient blips without
// hammering the API. 429/5xx are retried; 4xx (bad request, bad auth) are not.
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 500;     // first retry waits ~500ms
const MAX_DELAY_MS = 8000;     // never wait longer than 8s between retries

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MeetStreamClient {
  constructor(apiKey, logger) {
    this.apiKey = apiKey;
    this.logger = logger;
  }

  #headers() {
    return {
      Authorization: `Token ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Issues a request with automatic retry on transient failures.
   *
   *  - 429 (rate limited): honors `Retry-After` header if present,
   *    otherwise falls back to exponential backoff.
   *  - 5xx (server error) or network failure: exponential backoff.
   *  - 4xx other than 429 (bad request, bad auth, not found): fails
   *    immediately — retrying won't fix a malformed request or bad key.
   */
  async #request(method, path, body) {
    const url = `${BASE_URL}${path}`;
    let lastErr;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, {
          method,
          headers: this.#headers(),
          body: body ? JSON.stringify(body) : undefined,
        });

        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { raw: text }; }

        if (res.ok) return data;

        // Non-retryable: bad request / auth / not found — fail fast
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new Error(`MeetStream API ${method} ${path} → ${res.status}: ${text}`);
        }

        // Retryable: 429 (rate limited) or 5xx (server-side issue)
        lastErr = new Error(`MeetStream API ${method} ${path} → ${res.status}: ${text}`);

        if (attempt < MAX_RETRIES) {
          const retryAfterHeader = res.headers.get("retry-after");
          const delay = retryAfterHeader
            ? parseInt(retryAfterHeader, 10) * 1000
            : Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);

          this.logger.info(
            `MeetStream API ${res.status} on ${path} — retrying in ${(delay / 1000).toFixed(1)}s ` +
            `(attempt ${attempt + 1}/${MAX_RETRIES})`
          );
          await sleep(delay);
          continue;
        }
      } catch (err) {
        // Network-level failure (DNS, connection reset, timeout, etc.)
        lastErr = err;
        if (err.message?.includes("MeetStream API") && !err.message.includes("→ 5") && !err.message.includes("→ 429")) {
          throw err; // non-retryable API error thrown above — propagate immediately
        }
        if (attempt < MAX_RETRIES) {
          const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
          this.logger.info(
            `Network error on ${path} — retrying in ${(delay / 1000).toFixed(1)}s ` +
            `(attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message}`
          );
          await sleep(delay);
          continue;
        }
      }
    }

    throw lastErr;
  }

  /**
   * POST /bots/create_bot
   *
   * live_transcription_required only takes { webhook_url }.
   * The transcription provider is configured separately under
   * recording_config.transcript.provider.
   *
   * We use "meeting_captions" as the provider — it's MeetStream's
   * built-in captioning engine and requires no external API key.
   *
   * Audio: PCM16 little-endian, 48 kHz, mono, per-speaker binary frames.
   */
  async createBot({ meetingLink, callbackUrl, transcriptWebhookUrl, audioWsUrl }) {
    const payload = {
      meeting_link: meetingLink,
      bot_name: "MeetStream Labs Bot",
      audio_required: true,
      video_required: false,
      bot_message: "👋 MeetStream Labs bot is recording this meeting.",

      // Bot lifecycle events → our webhook
      callback_url: callbackUrl,

      // Live transcript segments streamed to our webhook in real time.
      // Provider is configured in recording_config below — NOT here.
      live_transcription_required: {
        webhook_url: transcriptWebhookUrl,
      },

      // Raw PCM audio frames over WebSocket (48 kHz, 16-bit LE, mono)
      live_audio_required: {
        websocket_url: audioWsUrl,
      },

      // Transcription provider + participant events + retention
      recording_config: {
        transcript: {
          provider: {
            // meeting_captions = MeetStream's built-in provider, no extra key needed.
            // Swap for: deepgram: { model: "nova-3" }  if you have a Deepgram key.
            meeting_captions: {},
          },
        },
        realtime_endpoints: [
          {
            type: "webhook",
            url: callbackUrl,
            events: ["participant_events.join", "participant_events.leave"],
          },
        ],
        retention: {
          type: "timed",
          hours: 24,
        },
      },

      // Auto-exit policies
      automatic_leave: {
        waiting_room_timeout: 600,        // 10 min in lobby before giving up
        everyone_left_timeout: 60,        // 1 min after last person leaves
        in_call_recording_timeout: 14400, // 4-hour hard cap
        recording_permission_denied_timeout: 60,
      },
    };

    this.logger.info("Creating MeetStream bot…");
    const data = await this.#request("POST", "/bots/create_bot", payload);
    return data.bot_id;
  }

  async getStatus(botId) {
    return this.#request("GET", `/bots/${botId}/status`);
  }

  async removeBot(botId) {
    return this.#request("GET", `/bots/${botId}/remove`);
  }

  async getTranscript(transcriptId) {
    return this.#request("GET", `/transcript/${transcriptId}/get_transcript`);
  }
}