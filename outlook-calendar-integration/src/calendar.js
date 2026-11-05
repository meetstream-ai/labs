/**
 * Outlook calendar connection calls used by index.js.
 */

import { call, request } from "./api.js";

/**
 * POST /calendar/create_outlook_calendar
 *
 * Connects exactly one Microsoft account. Field names must carry the
 * `microsoft_` prefix.
 *
 * MeetStream resolves the account's primary email through Microsoft Graph and
 * uses it as the connection's `account_id`. Reconnecting an account that is
 * already attached returns 409 unless you pass `replace: true`, so 409 is
 * returned to the caller here rather than thrown.
 */
export async function connectOutlookCalendar({ clientId, clientSecret, refreshToken, replace }) {
  const body = {
    microsoft_client_id: clientId,
    microsoft_client_secret: clientSecret,
    microsoft_refresh_token: refreshToken,
  };
  if (replace) body.replace = true;

  return call("/calendar/create_outlook_calendar", {
    method: "POST",
    body,
    accept: [409],
  });
}

/**
 * GET /calendar (list connected calendars)
 *
 * Lists every calendar connection on the MeetStream user grouped by provider.
 * Documented in the Outlook integration guide. It is not part of every
 * deployment's surface, so a 404 here is reported as "unavailable" instead of
 * failing the run.
 */
export async function listConnections() {
  // GET /calendar is the documented endpoint for listing connected calendars.
  // (There is no /calendar/connections path in the API.)
  const res = await request("/calendar", { method: "GET" });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return res.data;
}

/**
 * GET /calendar
 *
 * Lists the calendars behind the connection. Live read through to the
 * provider, so a clean result proves the credentials work.
 */
export async function listCalendars() {
  const { data } = await call("/calendar", { method: "GET" });
  return data;
}

/** Formats one calendar row for the console. */
export function formatCalendar(cal) {
  const flags = [
    cal.isPrimary ? "primary" : null,
    cal.accessRole ? `role=${cal.accessRole}` : null,
    cal.timeZone ? cal.timeZone : null,
  ]
    .filter(Boolean)
    .join(", ");
  return `  - ${cal.summary || cal.id}${flags ? `  (${flags})` : ""}`;
}
