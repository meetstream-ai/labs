import axios from 'axios';
import path from 'path';
import fs from 'fs-extra';
import logger from './logger.js';
import { sleep, backoffDelay } from './utils.js';

const BASE_URL = 'https://api.meetstream.ai/api/v1';

/**
 * Pull the human-readable message out of a MeetStream error body.
 * @param {any} data
 * @returns {string}
 */
function extractApiMessage(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data.slice(0, 300);
  const msg = data.message ?? data.error ?? data.detail;
  if (typeof msg === 'string') return msg;
  try {
    return JSON.stringify(data).slice(0, 300);
  } catch {
    return '';
  }
}

/**
 * Dedicated MeetStream API client.
 *
 * Centralizes:
 *   - authentication
 *   - bot creation (with per-participant video/audio enabled)
 *   - fetching per-participant recording streams
 *   - media download
 *   - retry/backoff on transient failures (429 / 5xx / timeouts)
 *
 * Endpoint paths, methods, and payload shapes below are taken directly from
 * MeetStream's published documentation (https://docs.meetstream.ai):
 *   - Create Bot:            POST /bots/create_bot
 *   - Remove Bot:            GET  /bots/{bot_id}/remove_bot   (yes, GET)
 *   - Get Recording Streams: GET  /bots/{bot_id}/get_recording_streams
 *   - Get Audio Streams:     GET  /bots/{bot_id}/get_audio_streams
 * If MeetStream changes these in a future API version, this is the only
 * file that should need updating.
 */
export class MeetStreamClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {number} [opts.maxRetries]
   * @param {number} [opts.retryBaseDelayMs]
   * @param {number} [opts.timeoutMs]
   */
  constructor({ apiKey, maxRetries = 5, retryBaseDelayMs = 1000, timeoutMs = 30_000 }) {
    this.maxRetries = maxRetries;
    this.retryBaseDelayMs = retryBaseDelayMs;

    this.http = axios.create({
      baseURL: BASE_URL,
      timeout: timeoutMs,
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Wraps an axios call with retry/backoff for transient failures.
   * Retries on: network/timeout errors, HTTP 429, and HTTP 5xx.
   * A 202 (still processing) is treated as a *successful* response by the
   * caller, not a failure - callers that expect 202 must pass a
   * validateStatus that accepts it.
   *
   * @param {() => Promise<import('axios').AxiosResponse>} requestFn
   * @param {string} label - human-readable operation name, for logging
   */
  async #withRetry(requestFn, label) {
    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await requestFn();
      } catch (err) {
        lastError = err;
        const status = err.response?.status;
        const isRetryable =
          !err.response || status === 429 || (status >= 500 && status < 600);

        if (!isRetryable || attempt === this.maxRetries) {
          if (err.response) {
            // Surface the API's own message (MeetStream returns `message`,
            // `error` or `detail`) instead of axios's generic text. The
            // original `err.response` is kept so callers can still branch
            // on status.
            const apiMessage = extractApiMessage(err.response.data);
            err.message = `${label} failed with HTTP ${status}${apiMessage ? `: ${apiMessage}` : ''}`;
            logger.debug(
              `${label} error body: ${JSON.stringify(err.response.data)}`
            );
          }
          throw err;
        }

        const delay = backoffDelay(attempt, this.retryBaseDelayMs);
        logger.warn(
          `${label} failed (attempt ${attempt + 1}/${this.maxRetries + 1}, status ${
            status ?? 'network error'
          }). Retrying in ${Math.round(delay)}ms...`
        );
        await sleep(delay);
      }
    }

    throw lastError;
  }

  /**
   * Create a bot that joins the meeting and records every participant's
   * video/audio as independent streams.
   *
   * @param {object} params
   * @param {string} params.meetingLink
   * @param {string} params.botName
   * @param {string} params.callbackUrl - public webhook URL (from ngrok)
   * @returns {Promise<{ bot_id: string, [key: string]: any }>}
   */
  async createBot({ meetingLink, botName, callbackUrl }) {
    const payload = {
      meeting_link: meetingLink,
      bot_name: botName,
      bot_message: 'Audio and video are being recorded by MeetStream.',
      callback_url: callbackUrl,
      // Composite (single-file) recording of the whole meeting view.
      video_required: true,
      audio_required: true,
      // Per Participant Video: one WebM/VP8 file per participant's webcam
      // (and screen shares), independent of the composite recording.
      video_separate_streams: true,
      audio_separate_streams: true,
    };

    logger.info('Creating bot...');
    const res = await this.#withRetry(
      () => this.http.post('/bots/create_bot', payload),
      'createBot'
    );
    logger.info(`Bot created (bot_id: ${res.data.bot_id})`);
    return res.data;
  }

  /**
   * Ask the bot to leave the meeting (used for graceful shutdown/cleanup).
   * Per MeetStream's docs this is a GET request (not POST).
   * Best-effort: failures are logged, not thrown, since this typically
   * runs during shutdown and the bot may have already left/stopped on its
   * own, which some accounts report as a 404.
   * @param {string} botId
   * @returns {Promise<{ alreadyGone: boolean }>}
   */
  async removeBot(botId) {
    try {
      const res = await this.#withRetry(
        () => this.http.get(`/bots/${botId}/remove_bot`),
        'removeBot'
      );
      logger.info(res.data?.message ?? 'Bot removed from meeting.');
      return { alreadyGone: false };
    } catch (err) {
      const status = err.response?.status;
      if (status === 404) {
        logger.debug('Bot was already gone from the meeting (404 on remove_bot).');
        return { alreadyGone: true };
      } else {
        logger.warn(`Could not remove bot cleanly: ${err.message}`);
        return { alreadyGone: false };
      }
    }
  }

  /**
   * Fetch per-participant video recording streams for a bot.
   *
   * Returns `{ ready: true, data }` once processing is complete (HTTP 200),
   * or `{ ready: false, data }` while still processing (HTTP 202). Throws
   * for any other failure.
   *
   * @param {string} botId
   * @returns {Promise<{ ready: boolean, data: object }>}
   */
  async getRecordingStreams(botId) {
    const res = await this.#withRetry(
      () =>
        this.http.get(`/bots/${botId}/get_recording_streams`, {
          validateStatus: (s) => s === 200 || s === 202,
        }),
      'getRecordingStreams'
    );
    return { ready: res.status === 200, data: res.data };
  }

  /**
   * Fetch per-participant audio streams for a bot.
   *
   * @param {string} botId
   * @returns {Promise<{ ready: boolean, data: object }>}
   */
  async getAudioStreams(botId) {
    const res = await this.#withRetry(
      () =>
        this.http.get(`/bots/${botId}/get_audio_streams`, {
          validateStatus: (s) => s === 200 || s === 202,
        }),
      'getAudioStreams'
    );
    return { ready: res.status === 200, data: res.data };
  }

  /**
   * Stream-download a media file from a presigned
   * URL to disk. MeetStream's segment URLs are presigned S3 URLs that
   * expire after 10 minutes and don't need an Authorization header, but we
   * still send our own headers in case a given URL turns out to be a
   * direct API route instead.
   *
   * @param {string} url
   * @param {string} destPath
   */
  async downloadMedia(url, destPath) {
    await fs.ensureDir(path.dirname(destPath));

    await this.#withRetry(async () => {
      const response = await axios.get(url, {
        responseType: 'stream',
        timeout: 0, // media downloads can be long; don't cap this one
        validateStatus: (s) => s === 200,
      });

      await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(destPath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
        response.data.on('error', reject);
      });

      return response;
    }, `downloadMedia(${destPath})`);
  }
}
