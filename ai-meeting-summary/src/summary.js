/**
 * Fetching MeetStream's native AI meeting summary.
 *
 * `GET /bots/{bot_id}/summary` returns the generated summary for a bot once
 * the meeting has finished and post-call processing has run. While the
 * summary is still being generated the endpoint answers HTTP 202, so this
 * module polls with a hard cap rather than looping forever.
 *
 * The response uses the same envelope as `GET /bots/{bot_id}/detail`
 * (`{ bot_details: { ... } }`), so we unwrap `bot_details` when present.
 */

import { envInt, pollUntilReady } from './client.js';

/**
 * @param {import('./client.js').MeetStreamClient} client
 * @param {string} botId
 * @returns {Promise<{ raw: any, body: any, attempts: number }>}
 */
export async function fetchSummary(client, botId) {
  const maxAttempts = envInt('SUMMARY_POLL_MAX_ATTEMPTS', 30);
  const intervalMs = envInt('SUMMARY_POLL_INTERVAL_MS', 10_000);

  const { data, attempts } = await pollUntilReady(() => client.getSummary(botId), {
    intervalMs,
    maxAttempts,
    label: 'The AI summary',
    onWait: (attempt) =>
      console.log(
        `  summary still generating (HTTP 202) - attempt ${attempt}/${maxAttempts}, ` +
          `retrying in ${Math.round(intervalMs / 1000)}s`
      ),
  });

  return { raw: data, body: unwrap(data), attempts };
}

/** Unwrap the `{ bot_details: {...} }` envelope if it is there. */
export function unwrap(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.bot_details) {
    return payload.bot_details;
  }
  return payload;
}
