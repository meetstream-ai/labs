/**
 * Waiting for a bot to be live, and running a timed announcement plan.
 */

import { log, c } from "./logger.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// GET /bots/{id}/status returns one of these. Match case-insensitively, since
// this string is also what shows up as `bot_status` in webhooks.
const LIVE = new Set(["inmeeting", "recording"]);
const TERMINAL = new Set(["stopped", "notallowed", "denied", "error", "done"]);

/**
 * Poll GET /bots/{bot_id}/status until the bot is actually in the meeting.
 * Messages sent before that point have nowhere to land.
 *
 * @returns {Promise<string>} the status that resolved the wait
 */
export async function waitForInMeeting(client, botId, { timeoutSeconds = 600, pollMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastSeen = null;

  while (Date.now() < deadline) {
    const { status } = await client.getStatus(botId);
    const normalised = String(status ?? "").toLowerCase();

    if (normalised !== lastSeen) {
      log.info(`Bot status: ${c("cyan", status ?? "unknown")}`);
      lastSeen = normalised;
    }

    if (LIVE.has(normalised)) return status;

    if (TERMINAL.has(normalised)) {
      throw new Error(
        `Bot reached terminal status "${status}" before joining. ` +
        (normalised === "notallowed"
          ? "It timed out in the waiting room."
          : normalised === "denied"
            ? "The host denied entry."
            : "Nothing to send to.")
      );
    }

    await sleep(pollMs);
  }

  throw new Error(
    `Bot did not reach the meeting within ${timeoutSeconds}s. ` +
    "Raise --wait-timeout, or admit the bot from the waiting room."
  );
}

/**
 * Send each entry at its offset. Offsets are absolute from t0, not cumulative,
 * so a plan of 0s / 300s / 600s sends at exactly those points.
 *
 * A failed send is logged and the plan continues. One rejected message should
 * not silently cancel the rest of the announcements.
 *
 * @param {{ afterSeconds: number, message: string }[]} schedule sorted ascending
 * @returns {Promise<{ sent: number, failed: number }>}
 */
export async function runSchedule(client, botId, schedule) {
  const t0 = Date.now();
  let sent = 0;
  let failed = 0;

  for (const entry of schedule) {
    const waitMs = t0 + entry.afterSeconds * 1000 - Date.now();
    if (waitMs > 0) {
      log.detail(`Next message in ${(waitMs / 1000).toFixed(0)}s: "${truncate(entry.message)}"`);
      await sleep(waitMs);
    }

    try {
      const result = await client.sendMessage(botId, entry.message);
      sent++;
      const replay = result._replayed ? c("dim", " (idempotent replay)") : "";
      log.success(`t+${entry.afterSeconds}s  sent: "${truncate(entry.message)}"${replay}`);
    } catch (err) {
      failed++;
      log.error(`t+${entry.afterSeconds}s  failed: "${truncate(entry.message)}"`, err);
      if (err.hint) log.detail(err.hint);
    }
  }

  return { sent, failed };
}

function truncate(text, max = 60) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
