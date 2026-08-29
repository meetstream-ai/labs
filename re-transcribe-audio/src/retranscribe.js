/**
 * Triggering and tracking a re-transcription run.
 *
 *   POST /bots/{bot_id}/transcribe
 *   { "provider": { "<key>": { ... } }, "callback_url": "https://..." }
 *
 * The bot's recorded audio is transcribed again with the provider you name.
 * The original transcript is not replaced - each run gets its own
 * `transcript_id`, and `GET /bots/{bot_id}/transcriptions` lists them all.
 */

import { api, sleep } from "./client.js";
import { listTranscriptions } from "./resolve.js";

/**
 * Every transcript_id that already exists for this bot, so we can tell which
 * run is the new one afterwards.
 */
export async function snapshotTranscriptIds(botId) {
  try {
    const runs = await listTranscriptions(botId);
    return new Set(runs.map((run) => run.transcript_id));
  } catch (err) {
    // A bot with no transcriptions yet is a perfectly normal starting point.
    if (err.status === 404) return new Set();
    throw err;
  }
}

/**
 * Kick off the re-transcription.
 *
 * @param {string} botId
 * @param {object} providerBlock  e.g. { deepgram: { model: "nova-3" } }
 * @param {string} [callbackUrl]  Webhook notified when the run finishes
 * @returns {Promise<any>} the API response body
 */
export async function startReTranscription(botId, providerBlock, callbackUrl) {
  const body = { provider: providerBlock };
  if (callbackUrl) body.callback_url = callbackUrl;

  const { data } = await api(`/bots/${encodeURIComponent(botId)}/transcribe`, {
    method: "POST",
    body,
  });
  return data;
}

/**
 * Find the transcript_id created by the run we just started.
 *
 * The response to /transcribe may already contain it. If it does not, poll
 * /transcriptions until an id appears that was not in the pre-run snapshot.
 *
 * @returns {Promise<{ transcriptId: string, run: object|null }>}
 */
export async function findNewTranscriptId(botId, before, response, options = {}) {
  const { maxAttempts = 12, intervalMs = 3000, onWait } = options;

  if (typeof response?.transcript_id === "string" && response.transcript_id) {
    return { transcriptId: response.transcript_id, run: null };
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const runs = await listTranscriptions(botId);
    const fresh = runs.filter((run) => !before.has(run.transcript_id));

    if (fresh.length > 0) {
      // Newest first, in case several runs landed at once.
      fresh.sort((a, b) => Date.parse(b?.created_at ?? "") - Date.parse(a?.created_at ?? ""));
      return { transcriptId: fresh[0].transcript_id, run: fresh[0] };
    }

    if (onWait) onWait(attempt, maxAttempts);
    if (attempt < maxAttempts) await sleep(intervalMs);
  }

  throw new Error(
    `The re-transcription was accepted but no new transcript_id appeared within ` +
      `${Math.round((maxAttempts * intervalMs) / 1000)}s.\n` +
      `Check GET /bots/${botId}/transcriptions directly.`,
  );
}
