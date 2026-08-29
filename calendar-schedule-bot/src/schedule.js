/**
 * Scheduling and unscheduling a bot for one calendar event.
 */

import { call } from "./api.js";

/**
 * Builds the bot_config sent inside the schedule request.
 *
 * Calendar bot_config accepts the same fields as create_bot, plus
 * `audio_required`, which create_bot does not have. Everything below is drawn
 * from the documented calendar bot_config surface: bot_name, bot_message,
 * bot_image_url, audio_required, video_required, callback_url, join_at,
 * deduplication_key, automatic_leave, recording_config, custom_attributes,
 * live_audio_required, live_transcription_required.
 */
export function buildBotConfig(env = process.env) {
  const config = {
    bot_name: env.BOT_NAME || "MeetStream Calendar Bot",
    audio_required: true,
    video_required: String(env.VIDEO_REQUIRED || "false").toLowerCase() === "true",
  };

  if (env.BOT_MESSAGE) config.bot_message = env.BOT_MESSAGE;
  if (env.CALLBACK_URL) config.callback_url = env.CALLBACK_URL;

  // Timeouts are in seconds. no_one_joined_timeout is specific to calendar
  // bot_config, it has no create_bot equivalent.
  const automaticLeave = {};
  if (env.NO_ONE_JOINED_TIMEOUT) {
    automaticLeave.no_one_joined_timeout = Number(env.NO_ONE_JOINED_TIMEOUT);
  }
  if (env.EVERYONE_LEFT_TIMEOUT) {
    automaticLeave.everyone_left_timeout = Number(env.EVERYONE_LEFT_TIMEOUT);
  }
  if (env.WAITING_ROOM_TIMEOUT) {
    automaticLeave.waiting_room_timeout = Number(env.WAITING_ROOM_TIMEOUT);
  }
  if (Object.keys(automaticLeave).length) config.automatic_leave = automaticLeave;

  // Opt-in post-call transcription. Calendar bot_config takes the provider
  // under `transcription`, which is a different shape from create_bot's
  // recording_config.transcript.provider. See the README.
  const provider = env.TRANSCRIPTION_PROVIDER;
  if (provider === "deepgram") {
    config.transcription = {
      deepgram: {
        model: env.DEEPGRAM_MODEL || "nova-3",
        language: env.TRANSCRIPTION_LANGUAGE || "en",
      },
    };
  } else if (provider === "assemblyai") {
    config.transcription = {
      assemblyai: { language_code: env.TRANSCRIPTION_LANGUAGE || "en" },
    };
  } else if (provider) {
    // sarvam, jigsawstack, meetstream and the *_streaming variants take
    // provider-specific options. Pass an empty object rather than inventing
    // fields that may not exist for that provider.
    config.transcription = { [provider]: {} };
  }

  if (env.DEDUPLICATION_KEY) config.deduplication_key = env.DEDUPLICATION_KEY;

  return config;
}

/**
 * POST /calendar/schedule/{event_id}
 *
 * Returns { status, data }. Status 409 means a bot is already scheduled for
 * this event and `data` carries the existing bot's id, so the caller can
 * handle it without treating it as a failure.
 *
 * Optional body fields beyond bot_config:
 *   occurrence_date          ISO 8601, one specific occurrence of a series
 *   schedule_all_occurrences bool, schedule every future occurrence
 *   occurrence_limit         int, cap for schedule_all_occurrences, default 52
 *   recurring_event          bool, auto-schedule the next occurrence each time
 */
export async function scheduleBot(eventId, botConfig, options = {}) {
  const body = { bot_config: botConfig };

  if (options.occurrenceDate) body.occurrence_date = options.occurrenceDate;
  if (options.scheduleAllOccurrences) body.schedule_all_occurrences = true;
  if (options.occurrenceLimit) body.occurrence_limit = options.occurrenceLimit;
  if (options.recurringEvent) body.recurring_event = true;

  return call(`/calendar/schedule/${encodeURIComponent(eventId)}`, {
    method: "POST",
    body,
    accept: [409],
  });
}

/**
 * DELETE /calendar/schedule/{event_id}
 *
 * Optional body:
 *   cancel_all_occurrences  bool, cancel the whole recurring series
 *   from_date               ISO 8601, only cancel occurrences from this date on
 */
export async function unscheduleBot(eventId, options = {}) {
  const body = {};
  if (options.cancelAllOccurrences) body.cancel_all_occurrences = true;
  if (options.fromDate) body.from_date = options.fromDate;

  const { data } = await call(`/calendar/schedule/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    body: Object.keys(body).length ? body : undefined,
  });
  return data;
}

/** GET /calendar/events, used to find an event id and to show current state. */
export async function fetchEvents(query = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") clean[key] = value;
  }
  const { data } = await call("/calendar/events", { method: "GET", query: clean });
  return Array.isArray(data.results) ? data.results : [];
}

/**
 * Picks the soonest upcoming event that has a meeting link and no bot yet.
 * Used when no event id is supplied, so the template is runnable out of the box.
 */
export function pickSchedulableEvent(events) {
  const now = Date.now();
  return events
    .filter((e) => !e.is_deleted && e.meeting_url)
    .filter((e) => !Array.isArray(e.bots) || e.bots.length === 0)
    .filter((e) => {
      const start = Date.parse(e.start_time);
      return Number.isNaN(start) ? false : start > now;
    })
    .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)))[0];
}
