/**
 * Recurring event helpers.
 */

import { call } from "./api.js";

/** GET /calendar/events */
export async function fetchEvents(query = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") clean[key] = value;
  }
  const { data } = await call("/calendar/events", { method: "GET", query: clean });
  return Array.isArray(data.results) ? data.results : [];
}

/**
 * POST /calendar/toggle-recurrence
 *
 * Flips auto-rescheduling for one event. There is no path parameter, the
 * event id goes in the body.
 *
 * Returns 400 when the event has no recurrence rule, so 400 is passed back to
 * the caller here to produce a useful message instead of a raw failure.
 */
export async function toggleRecurrence(eventId, enabled) {
  return call("/calendar/toggle-recurrence", {
    method: "POST",
    body: { event_id: eventId, recurring_enabled: enabled },
    accept: [400],
  });
}

/**
 * POST /calendar/schedule/{event_id} with the recurring options.
 *
 * Three separate strategies live behind this one endpoint:
 *   recurring_event: true          chain, schedule the next occurrence after each
 *   schedule_all_occurrences: true batch, schedule every future occurrence now
 *   occurrence_date: "<iso>"       one specific occurrence and nothing else
 */
export async function scheduleRecurring(eventId, botConfig, options = {}) {
  const body = { bot_config: botConfig };

  if (options.recurringEvent) body.recurring_event = true;
  if (options.scheduleAllOccurrences) {
    body.schedule_all_occurrences = true;
    if (options.occurrenceLimit) body.occurrence_limit = options.occurrenceLimit;
  }
  if (options.occurrenceDate) body.occurrence_date = options.occurrenceDate;

  return call(`/calendar/schedule/${encodeURIComponent(eventId)}`, {
    method: "POST",
    body,
    accept: [409],
  });
}

/**
 * DELETE /calendar/schedule/{event_id}
 *
 * cancel_all_occurrences drops the whole series. from_date keeps the
 * occurrences before that date and cancels everything after it.
 */
export async function cancelSchedule(eventId, options = {}) {
  const body = {};
  if (options.cancelAllOccurrences) body.cancel_all_occurrences = true;
  if (options.fromDate) body.from_date = options.fromDate;

  const { data } = await call(`/calendar/schedule/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    body: Object.keys(body).length ? body : undefined,
  });
  return data;
}

/** Minimal bot_config for the scheduling commands. */
export function buildBotConfig(env = process.env) {
  const config = {
    bot_name: env.BOT_NAME || "MeetStream Recurring Bot",
    audio_required: true,
    video_required: String(env.VIDEO_REQUIRED || "false").toLowerCase() === "true",
  };
  if (env.CALLBACK_URL) config.callback_url = env.CALLBACK_URL;
  return config;
}

/**
 * Best-effort read of recurrence information out of the raw provider event.
 *
 * The `raw` field is the untouched upstream payload, so its shape depends on
 * the provider:
 *   Google Calendar  raw.recurrence is an array of RRULE strings on the series
 *                    master; instances carry raw.recurringEventId
 *   Microsoft Graph  raw.recurrence is an object on the series master;
 *                    occurrences carry raw.seriesMasterId and raw.type
 *
 * Returns null when nothing recurrence-like is present. This is a display
 * hint only. `toggle-recurrence` is the authority, and it answers 400 when an
 * event genuinely has no recurrence rule.
 */
export function inspectRecurrence(event) {
  const raw = event.raw && typeof event.raw === "object" ? event.raw : {};

  if (Array.isArray(raw.recurrence) && raw.recurrence.length) {
    const rule = raw.recurrence.find((r) => String(r).toUpperCase().startsWith("RRULE"));
    return { kind: "series", rule: rule ? String(rule).replace(/^RRULE:/i, "") : "recurring" };
  }

  if (raw.recurrence && typeof raw.recurrence === "object") {
    const pattern = raw.recurrence.pattern;
    const summary = pattern?.type
      ? `${pattern.type}${pattern.interval ? ` every ${pattern.interval}` : ""}`
      : "recurring";
    return { kind: "series", rule: summary };
  }

  if (raw.recurringEventId || raw.seriesMasterId) {
    return { kind: "occurrence", rule: null };
  }

  return null;
}

/** Human title from the raw provider event. */
export function eventTitle(event) {
  const raw = event.raw && typeof event.raw === "object" ? event.raw : {};
  return raw.summary || raw.subject || "(untitled)";
}
