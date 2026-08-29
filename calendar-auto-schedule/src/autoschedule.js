/**
 * Auto-scheduling (auto-join) controls.
 *
 * Naming note: the API reference pages titled "Setup Cron" and "Disable Cron"
 * document these same two endpoints. There is no separate /calendar/setup-cron
 * path. The cron in the name is the background job that runs every 24 hours,
 * which these calls switch on and off.
 */

import { call } from "./api.js";

/**
 * Builds default_bot_config, the config every auto-scheduled bot inherits.
 *
 * Documented fields: bot_name, audio_required, video_required, bot_message,
 * bot_image_url, callback_url and automatic_leave.
 */
export function buildDefaultBotConfig(env = process.env) {
  const config = {
    bot_name: env.BOT_NAME || "MeetStream Auto Bot",
    audio_required: true,
    video_required: String(env.VIDEO_REQUIRED || "false").toLowerCase() === "true",
  };

  if (env.BOT_MESSAGE) config.bot_message = env.BOT_MESSAGE;
  if (env.BOT_IMAGE_URL) config.bot_image_url = env.BOT_IMAGE_URL;
  if (env.CALLBACK_URL) config.callback_url = env.CALLBACK_URL;

  // All timeouts are integer seconds.
  const automaticLeave = {};
  const timeouts = {
    waiting_room_timeout: env.WAITING_ROOM_TIMEOUT,
    no_one_joined_timeout: env.NO_ONE_JOINED_TIMEOUT,
    everyone_left_timeout: env.EVERYONE_LEFT_TIMEOUT,
    voice_inactivity_timeout: env.VOICE_INACTIVITY_TIMEOUT,
    in_call_recording_timeout: env.IN_CALL_RECORDING_TIMEOUT,
    recording_permission_denied_timeout: env.RECORDING_PERMISSION_DENIED_TIMEOUT,
  };
  for (const [key, value] of Object.entries(timeouts)) {
    if (value !== undefined && value !== "") automaticLeave[key] = Number(value);
  }
  if (Object.keys(automaticLeave).length) config.automatic_leave = automaticLeave;

  // Calendar bot_config takes the transcription provider under `transcription`.
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
    config.transcription = { [provider]: {} };
  }

  return config;
}

/** POST /calendar/auto-schedule/enable */
export async function enableAutoSchedule(defaultBotConfig) {
  const { data } = await call("/calendar/auto-schedule/enable", {
    method: "POST",
    body: { default_bot_config: defaultBotConfig },
  });
  return data;
}

/** POST /calendar/auto-schedule/disable. No body required. */
export async function disableAutoSchedule() {
  const { data } = await call("/calendar/auto-schedule/disable", {
    method: "POST",
    body: {},
  });
  return data;
}

/** GET /calendar/auto-schedule/settings */
export async function getAutoScheduleSettings() {
  const { data } = await call("/calendar/auto-schedule/settings", { method: "GET" });
  return data;
}

/** GET /calendar/scheduled_bots, used to show what auto-scheduling produced. */
export async function listScheduledBots(limit = 100) {
  const { data } = await call("/calendar/scheduled_bots", {
    method: "GET",
    query: { limit: Math.min(Math.max(limit, 1), 100) },
  });
  return Array.isArray(data.scheduled_bots) ? data.scheduled_bots : [];
}
