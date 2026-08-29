/**
 * Scheduling helpers.
 *
 * A scheduled bot is just a normal bot created with a future `join_at`. Once it
 * exists, the endpoints that manage the schedule live under /calendar:
 *
 *   GET    /calendar/scheduled_bots            list scheduled bots
 *   PATCH  /calendar/scheduled_bots/{bot_id}   move it to a new time (body: scheduled_join_time)
 *   DELETE /calendar/scheduled_bots/{bot_id}   cancel it
 *
 * Those work on any scheduled bot, whether or not it came from a connected calendar.
 */

import { call } from "./api.js";

/**
 * Turns `--in <minutes>` or `--at <iso>` into an ISO 8601 UTC timestamp.
 * join_at wants ISO 8601, for example 2026-07-02T15:00:00Z.
 */
export function resolveJoinAt({ inMinutes, at }) {
  if (at) {
    const ms = Date.parse(at);
    if (Number.isNaN(ms)) {
      throw new Error(`--at is not a valid date: "${at}". Use ISO 8601, e.g. 2026-07-02T15:00:00Z`);
    }
    return new Date(ms).toISOString();
  }

  if (inMinutes !== null && inMinutes !== undefined) {
    if (!Number.isFinite(inMinutes)) {
      throw new Error(`--in must be a number of minutes, got "${inMinutes}"`);
    }
    return new Date(Date.now() + inMinutes * 60_000).toISOString();
  }

  throw new Error("Give a time with --in <minutes> or --at <iso timestamp>.");
}

export function warnIfPast(joinAt) {
  const ms = Date.parse(joinAt);
  if (ms <= Date.now()) {
    console.log("Warning: that time is in the past. The bot will try to join immediately.");
  }
}

export function untilText(joinAt) {
  const ms = Date.parse(joinAt) - Date.now();
  if (Number.isNaN(ms)) return "unknown";
  if (ms <= 0) return "now or overdue";

  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours < 24) return `in ${hours}h ${rem}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function pick(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function normalise(raw) {
  return {
    id: pick(raw, ["bot_id", "id"]),
    name: pick(raw, ["bot_name", "name"]),
    status: pick(raw, ["bot_status", "status", "state"]) ?? "Unknown",
    meeting: pick(raw, ["meeting_url", "meeting_link"]),
    joinAt: pick(raw, ["join_at", "joinAt", "scheduled_at"]),
    raw,
  };
}

/**
 * GET /bots, paginated as { bots, hasNextPage, nextCursor }, then keep the ones
 * that carry a join_at. There is no server-side scheduled filter, so this is
 * client side by necessity.
 */
export async function listBots({ maxPages = 20 } = {}) {
  const all = [];
  let cursor = null;
  const seen = new Set();

  for (let page = 0; page < maxPages; page++) {
    const { data } = await call("/bots", { query: cursor ? { cursor } : undefined });

    const items = Array.isArray(data) ? data : data?.bots ?? data?.results ?? data?.data ?? [];
    for (const item of items) {
      const bot = normalise(item);
      if (bot.id) all.push(bot);
    }

    const hasNext = data?.hasNextPage ?? data?.has_next_page ?? false;
    const next = data?.nextCursor ?? data?.next_cursor ?? null;
    if (!hasNext || !next || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }

  return all;
}

/**
 * GET /calendar/scheduled_bots - the dedicated "list scheduled bots" endpoint.
 *
 * Prefer this over paging all of GET /bots and filtering client-side: it returns only
 * bots that are actually scheduled. The GET /bots + `scheduledBots()` path below is kept
 * as a fallback (and to show how to spot a scheduled bot by its `join_at`).
 */
export async function listScheduledBots() {
  const { data } = await call("/calendar/scheduled_bots");
  const rows = Array.isArray(data) ? data : (data?.scheduled_bots ?? data?.bots ?? []);
  return rows;
}

/** Bots with a join_at, newest scheduled time last. `upcomingOnly` drops past ones. */
export function scheduledBots(bots, { upcomingOnly = true } = {}) {
  const withTime = bots.filter((b) => b.joinAt);
  const list = upcomingOnly
    ? withTime.filter((b) => {
        const ms = Date.parse(b.joinAt);
        return !Number.isNaN(ms) && ms > Date.now();
      })
    : withTime;

  return list.sort((a, b) => Date.parse(a.joinAt) - Date.parse(b.joinAt));
}

/**
 * PATCH /calendar/scheduled_bots/{bot_id} - move a scheduled bot to a new time.
 *
 * The request body field is `scheduled_join_time` (NOT `join_at`). `join_at` is the
 * field you pass to create_bot; the reschedule endpoint uses its own name. Verified
 * against the OpenAPI `RescheduleBotRequest` schema, where it is the only required field.
 */
export async function reschedule(botId, joinAt) {
  return call(`/calendar/scheduled_bots/${botId}`, {
    method: "PATCH",
    body: { scheduled_join_time: joinAt },
  });
}

/** DELETE /calendar/scheduled_bots/{bot_id}. Cancels a bot that has not joined yet. */
export async function cancel(botId) {
  return call(`/calendar/scheduled_bots/${botId}`, { method: "DELETE", accept: [202] });
}
