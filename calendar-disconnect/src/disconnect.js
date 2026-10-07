/**
 * Calendar disconnect, plus the read calls used to show what will be lost.
 */

import { call, request, errorMessage, MeetStreamError } from "./api.js";

/**
 * A rejected key must never be reported as "nothing is connected", or the
 * preview would understate what a disconnect is about to destroy.
 */
function throwIfAuthFailure(res) {
  if (res.status === 401 || res.status === 403) {
    throw new MeetStreamError(res.status, errorMessage(res.data, res.status), res.data);
  }
}

/** GET /calendar, the calendars behind the connection. */
export async function safeListCalendars() {
  const res = await request("/calendar", { method: "GET" });
  throwIfAuthFailure(res);
  return res.ok ? res.data : null;
}

/**
 * Alias kept for readability at the call site. There is no /calendar/connections
 * path in the API: GET /calendar is how you list connected calendars.
 */
export const safeListConnections = safeListCalendars;

/** GET /calendar/scheduled_bots, the bots that a disconnect will cancel. */
export async function safeListScheduledBots() {
  const res = await request("/calendar/scheduled_bots", {
    method: "GET",
    query: { limit: 100 },
  });
  if (!res.ok) return null;
  return Array.isArray(res.data?.scheduled_bots) ? res.data.scheduled_bots : [];
}

/** GET /calendar/events, used only to count what is currently synced. */
export async function safeCountEvents() {
  const res = await request("/calendar/events", { method: "GET", query: { limit: 100 } });
  if (!res.ok) return null;
  const results = Array.isArray(res.data?.results) ? res.data.results : [];
  return { counted: results.length, hasMore: Boolean(res.data?.has_more) };
}

/**
 * Builds the disconnect request body.
 *
 * Three documented shapes, all optional:
 *   {}                                every connection, only when the user has one
 *   { provider }                      every connection for that provider
 *   { provider, account_id }          one specific connection
 * plus `purge_events: false` to keep the historical event rows.
 *
 * The API reference additionally documents the Google OAuth credential fields
 * on this endpoint, so they are included when all three are present in the
 * environment.
 */
export function buildDisconnectBody({ provider, accountId, keepEvents, env = process.env }) {
  const body = {};

  if (provider) body.provider = provider;
  if (accountId) body.account_id = accountId;
  if (keepEvents) body.purge_events = false;

  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = env;
  if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN) {
    body.google_client_id = GOOGLE_CLIENT_ID;
    body.google_client_secret = GOOGLE_CLIENT_SECRET;
    body.google_refresh_token = GOOGLE_REFRESH_TOKEN;
  }

  return body;
}

/**
 * POST /calendar/disconnect
 *
 * 400 is passed back rather than thrown: with several connections attached the
 * API deliberately refuses an unscoped disconnect and returns a `next_steps`
 * hint, which is far more useful surfaced than raised.
 *
 * Some older deployments expose this verb as DELETE. If POST answers 404 or
 * 405 the same body is retried as DELETE rather than reporting a dead endpoint.
 */
export async function disconnectCalendar(body) {
  const res = await request("/calendar/disconnect", { method: "POST", body });

  if (res.status === 404 || res.status === 405) {
    const fallback = await request("/calendar/disconnect", { method: "DELETE", body });
    if (!fallback.ok && fallback.status !== 400) {
      throw new MeetStreamError(
        fallback.status,
        errorMessage(fallback.data, fallback.status),
        fallback.data
      );
    }
    return { ...fallback, usedDelete: true };
  }

  if (!res.ok && res.status !== 400) {
    throw new MeetStreamError(res.status, errorMessage(res.data, res.status), res.data);
  }

  return { ...res, usedDelete: false };
}
