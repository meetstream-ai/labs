/**
 * Event sync helpers for GET /calendar/events.
 */

import { call } from "./api.js";

/**
 * Fetches one page of events.
 *
 * GET /calendar/events syncs with the upstream provider first (incremental
 * where possible), stores the result, and returns it with pagination plus the
 * bots already linked to each event.
 *
 * Supported query parameters:
 *   calendar_id  a specific calendar, defaults to the primary one
 *   time_min     ISO 8601, defaults to now minus 1 day
 *   time_max     ISO 8601, defaults to now plus 28 days
 *   sync         "true" / "false", forces or skips the upstream sync
 *   limit        1 to 100, default 50
 *   cursor       the `next` value from the previous page
 *   provider     "google" or "outlook", for multi-account users
 *   account_id   scopes to one connected account, requires provider
 */
export async function fetchEventPage(query = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") clean[key] = value;
  }
  const { data } = await call("/calendar/events", { method: "GET", query: clean });
  return data;
}

/**
 * Walks the cursor pagination and returns every event, up to `maxEvents`.
 *
 * `has_more` and `next` are both consulted: a page can report has_more without
 * a usable cursor, and looping on that would spin forever.
 */
export async function fetchAllEvents(query = {}, maxEvents = 200) {
  const events = [];
  let cursor;
  let pages = 0;

  while (events.length < maxEvents) {
    const page = await fetchEventPage({ ...query, cursor });
    pages += 1;

    const results = Array.isArray(page.results) ? page.results : [];
    events.push(...results);

    if (!page.has_more || !page.next || results.length === 0) break;
    cursor = page.next;

    // Hard stop so a misbehaving cursor cannot loop indefinitely.
    if (pages >= 20) break;
  }

  return events.slice(0, maxEvents);
}

/** Known hosts for the meeting platforms MeetStream detects in calendar events. */
const HOST_PATTERNS = [
  [/(^|\.)meet\.google\.com$/i, "Google Meet"],
  [/(^|\.)zoom\.us$/i, "Zoom"],
  [/(^|\.)zoom\.com$/i, "Zoom"],
  [/(^|\.)teams\.microsoft\.com$/i, "Microsoft Teams"],
  [/(^|\.)teams\.live\.com$/i, "Microsoft Teams"],
  [/(^|\.)webex\.com$/i, "Webex"],
  [/(^|\.)gotomeeting\.com$/i, "GoToMeeting"],
  [/(^|\.)bluejeans\.com$/i, "BlueJeans"],
  [/(^|\.)whereby\.com$/i, "Whereby"],
];

/**
 * Works out which conferencing platform an event uses.
 *
 * Prefers the API's own `meeting_platform` label and falls back to the URL
 * host, which keeps the output readable for links the label does not cover.
 */
export function detectPlatform(event) {
  if (event.meeting_platform) {
    const label = String(event.meeting_platform);
    const pretty = {
      gmeet: "Google Meet",
      google_meet: "Google Meet",
      zoom: "Zoom",
      teams: "Microsoft Teams",
      msteams: "Microsoft Teams",
    }[label.toLowerCase()];
    return pretty || label;
  }

  if (!event.meeting_url) return null;

  try {
    const host = new URL(event.meeting_url).hostname;
    for (const [pattern, name] of HOST_PATTERNS) {
      if (pattern.test(host)) return name;
    }
    return host;
  } catch {
    return "unknown";
  }
}

/** True when MeetStream can actually put a bot in this event. */
export function hasMeetingLink(event) {
  return Boolean(event.meeting_url);
}

/**
 * Pulls a human title out of the raw provider event.
 * Google uses `summary`, Microsoft Graph uses `subject`.
 */
export function eventTitle(event) {
  const raw = event.raw && typeof event.raw === "object" ? event.raw : {};
  return raw.summary || raw.subject || "(untitled)";
}

/** Scheduled bots already attached to an event, if any. */
export function scheduledBots(event) {
  return Array.isArray(event.bots) ? event.bots : [];
}
