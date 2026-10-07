/**
 * Calendar connection calls used by index.js.
 */

import { call } from "./api.js";

/**
 * POST /calendar/create_calendar
 *
 * The three credential fields MUST carry the `google_` prefix. Plain
 * `client_id` / `client_secret` / `refresh_token` are rejected.
 *
 * Calling this again with fresh credentials replaces the existing connection,
 * so it is safe to re-run after rotating your OAuth client secret.
 */
export async function connectGoogleCalendar({ clientId, clientSecret, refreshToken }) {
  const { data } = await call("/calendar/create_calendar", {
    method: "POST",
    body: {
      google_client_id: clientId,
      google_client_secret: clientSecret,
      google_refresh_token: refreshToken,
    },
  });
  return data;
}

/**
 * GET /calendar
 *
 * Lists the calendars behind the connection. This is a live read through to
 * Google, so it is the honest way to prove the credentials actually work.
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
