/**
 * Creating a Microsoft Teams bot.
 *
 *   POST /bots/create_bot
 *
 * Teams needs no setup at all - pass a Teams meeting link and the bot joins.
 * There is no Teams-specific block on create_bot the way Zoom has `zoom` and
 * Google Meet has `google_meet`. The platform is inferred from the link.
 *
 * Teams-relevant automatic_leave defaults (from the automatic leave guide):
 *   waiting_room_timeout   600   (range 60 - 1800 on Teams)
 *   no_one_joined_timeout  600   (range 60 - 1800)
 *   everyone_left_timeout  300   (range 60 - 1800)
 * `recording_permission_denied_timeout` is Zoom only and is ignored here.
 *
 * Teams supports the `meeting_captions` transcription provider (native
 * captions). Note that a meeting_captions bot has no separate transcript
 * resource, so `transcript_id` comes back null on the create response.
 */

import { randomUUID } from 'node:crypto';

export const WAITING_ROOM_MIN = 60;
export const WAITING_ROOM_MAX_TEAMS = 1800;
export const IN_CALL_RECORDING_MIN = 600;

const TEAMS_HOST_PATTERN = /(^|\.)teams\.(microsoft\.com|live\.com|microsoft\.us)$/i;

export function isTeamsLink(link) {
  try {
    return TEAMS_HOST_PATTERN.test(new URL(link).hostname);
  } catch {
    return false;
  }
}

function assertRange(name, value, min, max) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer number of seconds.`);
  if (value < min || value > max) {
    throw new Error(
      `${name} must be between ${min} and ${max} seconds (got ${value}). ` +
        'Out-of-range values are rejected with HTTP 400.'
    );
  }
  return value;
}

export function buildAutomaticLeave({
  waitingRoomTimeout,
  noOneJoinedTimeout,
  everyoneLeftTimeout,
  inCallRecordingTimeout,
  voiceInactivityTimeout,
} = {}) {
  const automaticLeave = {};

  if (
    assertRange('waiting_room_timeout', waitingRoomTimeout, WAITING_ROOM_MIN, WAITING_ROOM_MAX_TEAMS) !==
    undefined
  ) {
    automaticLeave.waiting_room_timeout = waitingRoomTimeout;
  }
  if (assertRange('no_one_joined_timeout', noOneJoinedTimeout, 60, 1800) !== undefined) {
    automaticLeave.no_one_joined_timeout = noOneJoinedTimeout;
  }
  if (assertRange('everyone_left_timeout', everyoneLeftTimeout, 60, 1800) !== undefined) {
    automaticLeave.everyone_left_timeout = everyoneLeftTimeout;
  }
  if (assertRange('voice_inactivity_timeout', voiceInactivityTimeout, 60, 1800) !== undefined) {
    automaticLeave.voice_inactivity_timeout = voiceInactivityTimeout;
  }
  if (
    assertRange(
      'in_call_recording_timeout',
      inCallRecordingTimeout,
      IN_CALL_RECORDING_MIN,
      18_000
    ) !== undefined
  ) {
    automaticLeave.in_call_recording_timeout = inCallRecordingTimeout;
  }

  return automaticLeave;
}

/**
 * Build the transcript provider block. Pick exactly ONE provider key.
 *
 * Post-call providers: deepgram, assemblyai, sarvam, jigsawstack, meetstream
 * Native captions (Teams and Google Meet): meeting_captions
 */
export function buildTranscriptProvider(provider, { language = 'en' } = {}) {
  if (!provider) return undefined;
  switch (provider) {
    case 'deepgram':
      return { deepgram: { model: 'nova-3', language } };
    case 'assemblyai':
      return { assemblyai: { language_code: language } };
    case 'meeting_captions':
      return { meeting_captions: {} };
    case 'sarvam':
    case 'jigsawstack':
    case 'meetstream':
      return { [provider]: {} };
    default:
      throw new Error(
        `Unknown transcription provider "${provider}". Use deepgram, assemblyai, sarvam, ` +
          'jigsawstack, meetstream, or meeting_captions.'
      );
  }
}

/**
 * @param {ReturnType<import('./client.js').createClient>} client
 * @param {object} opts
 * @param {string}  opts.meetingLink
 * @param {string}  opts.botName
 * @param {string} [opts.callbackUrl]
 * @param {boolean} [opts.videoRequired]
 * @param {object} [opts.automaticLeave]
 * @param {object} [opts.recordingConfig]
 * @param {object} [opts.customAttributes]  string values only
 * @param {string} [opts.joinAt]            ISO 8601 time to join later
 */
export async function createTeamsBot(client, opts) {
  const {
    meetingLink,
    botName = 'MeetStream Notetaker',
    callbackUrl,
    videoRequired = false,
    automaticLeave,
    recordingConfig,
    customAttributes,
    joinAt,
  } = opts;

  if (!meetingLink) throw new Error('createTeamsBot requires a meetingLink.');
  if (!isTeamsLink(meetingLink)) {
    throw new Error(
      `"${meetingLink}" does not look like a Microsoft Teams meeting link ` +
        '(expected a teams.microsoft.com or teams.live.com URL).'
    );
  }

  const body = {
    meeting_link: meetingLink,
    bot_name: botName,
    video_required: videoRequired,
  };

  if (callbackUrl) body.callback_url = callbackUrl;
  if (joinAt) body.join_at = joinAt;
  if (automaticLeave && Object.keys(automaticLeave).length > 0) {
    body.automatic_leave = automaticLeave;
  }
  if (recordingConfig && Object.keys(recordingConfig).length > 0) {
    body.recording_config = recordingConfig;
  }
  if (customAttributes && Object.keys(customAttributes).length > 0) {
    body.custom_attributes = customAttributes;
  }

  const { data, replayed } = await client.request('/bots/create_bot', {
    method: 'POST',
    body,
    idempotencyKey: randomUUID(),
  });

  return { bot: data, replayed, request: body };
}

/** GET /bots/{id}/status */
export async function getBotStatus(client, botId) {
  const { data } = await client.request(`/bots/${encodeURIComponent(botId)}/status`);
  return data;
}

/** GET /bots/{id}/remove_bot - this endpoint really is a GET. */
export async function removeBot(client, botId) {
  const { data } = await client.request(`/bots/${encodeURIComponent(botId)}/remove_bot`);
  return data;
}
