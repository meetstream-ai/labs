/**
 * Listing, normalising, filtering and sorting bots.
 *
 * GET /bots returns a paginated envelope: { bots, hasNextPage, nextCursor }.
 * Individual bot records carry different fields depending on how the bot was
 * created (a scheduled bot has join_at, a finished one has timings), so every
 * read goes through normaliseBot() rather than assuming a fixed schema.
 */

import { call } from "./api.js";

/** Pull the first present key out of an object. */
function pick(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

export function normaliseBot(raw) {
  if (!raw || typeof raw !== "object") return null;

  return {
    id: pick(raw, ["bot_id", "id"]),
    name: pick(raw, ["bot_name", "name"]),
    status: pick(raw, ["bot_status", "status", "state"]) ?? "Unknown",
    meeting: pick(raw, ["meeting_url", "meeting_link"]),
    transcriptId: pick(raw, ["transcript_id"]),
    createdAt: pick(raw, ["created_at", "created", "createdAt"]),
    joinAt: pick(raw, ["join_at", "joinAt", "scheduled_at"]),
    raw,
  };
}

/**
 * Walks every page of GET /bots.
 *
 * SERVER-SIDE FILTERS (documented query params - prefer these over filtering in JS,
 * they cut response size and are much faster on big accounts):
 *   status    - e.g. "Recording", "Done", "Stopped"
 *   from / to - ISO 8601 time range
 *   platform  - e.g. "zoom", "google_meet", "microsoft_teams"
 *   custom_attr[<key>] - match a custom_attributes value you set on create_bot
 * Pass them via `filters`, e.g. listAllBots({ filters: { status: "Recording" } }).
 *
 * The cursor from `nextCursor` is sent back as the `cursor` query parameter.
 * `maxPages` stops a broken cursor from looping forever, and a repeated cursor
 * value also breaks the loop.
 */
export async function listAllBots({ maxPages = 20, filters = {} } = {}) {
  const bots = [];
  let cursor = null;
  let pages = 0;
  const seenCursors = new Set();

  while (pages < maxPages) {
    const query = { ...filters, ...(cursor ? { cursor } : {}) };
    const { data } = await call("/bots", {
      query: Object.keys(query).length ? query : undefined,
    });
    pages += 1;

    const page = Array.isArray(data)
      ? data
      : data?.bots ?? data?.results ?? data?.data ?? [];

    for (const item of page) {
      const bot = normaliseBot(item);
      if (bot?.id) bots.push(bot);
    }

    const hasNext = data?.hasNextPage ?? data?.has_next_page ?? false;
    const next = data?.nextCursor ?? data?.next_cursor ?? null;

    if (!hasNext || !next || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }

  return { bots, pages };
}

export function filterByStatus(bots, status) {
  if (!status) return bots;
  const wanted = status.toLowerCase();
  return bots.filter((b) => String(b.status).toLowerCase() === wanted);
}

const SORTERS = {
  status: (a, b) => String(a.status).localeCompare(String(b.status)),
  name: (a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")),
  id: (a, b) => String(a.id).localeCompare(String(b.id)),
  created: (a, b) => timeOf(b) - timeOf(a), // newest first
};

function timeOf(bot) {
  const value = bot.createdAt ?? bot.joinAt;
  const ms = value ? Date.parse(value) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

export function sortBots(bots, key = "created") {
  const sorter = SORTERS[key];
  if (!sorter) {
    throw new Error(`Unknown sort key "${key}". Use one of: ${Object.keys(SORTERS).join(", ")}`);
  }
  return [...bots].sort(sorter);
}

export function countByStatus(bots) {
  const counts = new Map();
  for (const bot of bots) {
    counts.set(bot.status, (counts.get(bot.status) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * GET /bots/{id}/remove_bot
 *
 * Note the verb: this is a GET, not a POST or DELETE. It makes an active bot
 * leave the meeting now. Recorded data is kept. To erase the data you need
 * DELETE /bots/{id}/delete, which is a different (and irreversible) call.
 */
export async function removeBot(botId) {
  const { status, data } = await call(`/bots/${botId}/remove_bot`, { accept: [202] });
  return { status, data };
}
