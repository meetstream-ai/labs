/**
 * Creating a bot and waiting for it to finish.
 */

import { randomUUID } from "node:crypto";

import { api, sleep } from "./client.js";

/** Statuses after which nothing more will happen in the meeting. */
const TERMINAL_STATUSES = new Set([
  "Stopped",
  "NotAllowed", // never admitted from the waiting room
  "Denied", // the host refused the join request
  "Error",
  "Done",
  "MediaExpired",
]);

/**
 * POST /bots/create_bot
 *
 * An `Idempotency-Key` header makes retries safe: replaying the same key
 * returns the original bot with HTTP 507 instead of creating a duplicate (and
 * without charging twice). `src/client.js` treats 507 as success.
 *
 * @returns {Promise<{ status: number, data: any }>}
 */
export async function createBot(payload) {
  return api("/bots/create_bot", {
    method: "POST",
    body: payload,
    headers: { "Idempotency-Key": randomUUID() },
  });
}

/** GET /bots/{bot_id}/status → { bot_id, status, custom_attributes } */
export async function getBotStatus(botId) {
  const { data } = await api(`/bots/${encodeURIComponent(botId)}/status`);
  return data?.status ?? "Unknown";
}

/**
 * Poll the bot's status until it reaches a terminal state.
 *
 * Polling keeps this template dependency-free. In production, prefer a
 * `callback_url` webhook - see the post-call-transcription template.
 *
 * @returns {Promise<string>} the terminal status
 */
export async function waitForBotToFinish(botId, options = {}) {
  const { maxAttempts = 240, intervalMs = 15000, onStatus } = options;

  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const status = await getBotStatus(botId);
    if (status !== last) {
      if (onStatus) onStatus(status, attempt);
      last = status;
    }
    if (TERMINAL_STATUSES.has(status)) return status;
    await sleep(intervalMs);
  }

  throw new Error(
    `Bot ${botId} did not reach a terminal status after ` +
      `${Math.round((maxAttempts * intervalMs) / 60000)} minutes. Last status: ${last}.`,
  );
}

/** Human-readable explanation for a terminal status that produced no audio. */
export function explainTerminalStatus(status) {
  switch (status) {
    case "NotAllowed":
      return "The bot was never admitted from the waiting room, so nothing was recorded.";
    case "Denied":
      return "The host denied the join request, so nothing was recorded.";
    case "Error":
      return "The bot errored out. Check GET /bots/{bot_id}/detail for the status timeline.";
    case "MediaExpired":
      return "The recording passed its retention window and has been deleted.";
    default:
      return null;
  }
}
