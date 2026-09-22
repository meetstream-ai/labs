/**
 * Scheduled bot administration.
 */

import { call, request } from "./api.js";

/**
 * GET /calendar/scheduled_bots
 *
 * Returns every bot with a join time in the future, both calendar-scheduled
 * bots and one-off bots created with a future `join_at`.
 *
 * `limit` is 1 to 100, default 100.
 */
export async function listScheduledBots(limit = 100) {
  const { data } = await call("/calendar/scheduled_bots", {
    method: "GET",
    query: { limit: Math.min(Math.max(Number(limit) || 100, 1), 100) },
  });
  return Array.isArray(data.scheduled_bots) ? data.scheduled_bots : [];
}

/**
 * PATCH /calendar/scheduled_bots/{bot_id}
 *
 * `scheduled_join_time` must be in the future. The API schema marks it
 * required; the integration guide additionally documents `bot_username` and
 * `custom_attributes` as updatable. This sends whatever the caller supplied.
 *
 * Response: { message, bot_id, updated_fields, schedule_updated }
 */
export async function updateScheduledBot(botId, patch) {
  if (!patch || Object.keys(patch).length === 0) {
    throw new Error("Nothing to update. Pass --time, --name or --attr.");
  }
  const { data } = await call(`/calendar/scheduled_bots/${encodeURIComponent(botId)}`, {
    method: "PATCH",
    body: patch,
  });
  return data;
}

/** DELETE /calendar/scheduled_bots/{bot_id}. Only for bots that have not joined. */
export async function deleteScheduledBot(botId) {
  const { data } = await call(`/calendar/scheduled_bots/${encodeURIComponent(botId)}`, {
    method: "DELETE",
  });
  return data;
}

/**
 * GET /bots/{bot_id}/status
 *
 * Live status straight from the bot record, used to enrich `show`. A failure
 * here should not sink the command, so this returns null instead of throwing.
 */
export async function getBotStatus(botId) {
  const res = await request(`/bots/${encodeURIComponent(botId)}/status`, { method: "GET" });
  return res.ok ? res.data : null;
}

/**
 * Validates an ISO 8601 join time and confirms it is in the future.
 * The API rejects past times, and catching it locally gives a better message.
 */
export function parseFutureIso(value) {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`Not a valid ISO 8601 timestamp: ${value}\nExample: 2026-04-22T15:00:00Z`);
  }
  if (ms <= Date.now()) {
    throw new Error(`Join time must be in the future. Got ${new Date(ms).toISOString()}`);
  }
  return new Date(ms).toISOString();
}

/**
 * Parses repeated --attr key=value pairs.
 * custom_attributes values must be strings.
 */
export function parseAttributes(pairs) {
  const attrs = {};
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index <= 0) {
      throw new Error(`--attr expects key=value, got: ${pair}`);
    }
    attrs[pair.slice(0, index)] = String(pair.slice(index + 1));
  }
  return attrs;
}
