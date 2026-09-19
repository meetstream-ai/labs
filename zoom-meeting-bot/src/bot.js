/**
 * Creating a Zoom bot.
 *
 *   POST /bots/create_bot
 *
 * Zoom-specific bits:
 *
 *   automatic_leave.recording_permission_denied_timeout
 *     How long the bot waits for the host to answer the recording-permission
 *     prompt. Range 60-300 seconds, default 60. Zoom only - ignored on Google
 *     Meet and Microsoft Teams. Out of range returns HTTP 400.
 *
 *   automatic_leave.waiting_room_timeout
 *     Range on Zoom is 60-1200 seconds (wider than Google Meet's 60-600),
 *     default 600.
 *
 *   zoom.zak_url / zoom.obf_url
 *     Authenticated joins. Each is an HTTPS URL on YOUR server that returns a
 *     fresh Zoom token when the bot calls it at join time: zak_url joins as a
 *     signed-in Zoom user, obf_url joins on behalf of a user already in the
 *     meeting. Send at most one. You run Zoom OAuth and keep the refresh tokens;
 *     MeetStream never stores them. The old use_zoom_obf /
 *     zoom_oauth_connection_user_id fields are rejected by the API. See the
 *     zoom-authenticated-joins template for a working token server.
 *
 * Password-protected meetings: pass the full invite link including its `?pwd=`
 * component as `meeting_link`.
 */

import { randomUUID } from 'node:crypto';

/** Query parameters that are credentials: a Zoom passcode, a mint-URL secret, tokens. */
const SECRET_QUERY_PARAMS = new Set(['pwd', 'auth', 'token', 'secret', 'key', 'api_key', 'signature']);

/**
 * Deep-copy `value` with every credential-bearing query parameter inside any
 * URL replaced by `***`. Used before a request body, a meeting link or an
 * error message is printed or sent to the alert webhook, so `?pwd=` passcodes
 * and the `auth=` secret on a zak_url / obf_url never reach a log.
 */
export function redactSecrets(value) {
  if (typeof value === 'string') {
    return value.replace(/https?:\/\/[^\s"'<>]+/g, (raw) => {
      try {
        const url = new URL(raw);
        let changed = false;
        for (const name of [...url.searchParams.keys()]) {
          if (SECRET_QUERY_PARAMS.has(name.toLowerCase())) {
            url.searchParams.set(name, '***');
            changed = true;
          }
        }
        return changed ? url.toString().replace(/%2A%2A%2A/g, '***') : raw;
      } catch {
        return raw;
      }
    });
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactSecrets(v)]));
  }
  return value;
}

/**
 * The `zoom` block for an authenticated join, or undefined for a guest join.
 * The API returns 400 when both URLs are sent, so refuse that up front.
 */
export function buildZoomAuth({ zakUrl, obfUrl } = {}) {
  if (zakUrl && obfUrl) {
    throw new Error('Set only one of ZOOM_ZAK_URL or ZOOM_OBF_URL, not both.');
  }
  for (const url of [zakUrl, obfUrl].filter(Boolean)) {
    if (!url.startsWith('https://')) {
      throw new Error(
        `Zoom token URL must be https (bots run in the cloud and cannot reach localhost): ${redactSecrets(url)}`
      );
    }
  }
  if (obfUrl && /[?&]meeting_number=/.test(obfUrl)) {
    throw new Error('Leave meeting_number off ZOOM_OBF_URL. MeetStream appends it at join time.');
  }
  if (zakUrl) return { zak_url: zakUrl };
  if (obfUrl) return { obf_url: obfUrl };
  return undefined;
}

export const RECORDING_PERMISSION_TIMEOUT_MIN = 60;
export const RECORDING_PERMISSION_TIMEOUT_MAX = 300;
export const WAITING_ROOM_MIN = 60;
export const WAITING_ROOM_MAX_ZOOM = 1200;
export const IN_CALL_RECORDING_MIN = 600;

const ZOOM_HOST_PATTERN = /(^|\.)zoom\.(us|com|com\.cn)$/i;

export function isZoomLink(link) {
  try {
    return ZOOM_HOST_PATTERN.test(new URL(link).hostname);
  } catch {
    return false;
  }
}

export function hasPasswordComponent(link) {
  try {
    return new URL(link).searchParams.has('pwd');
  } catch {
    return false;
  }
}

function assertRange(name, value, min, max) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer number of seconds.`);
  }
  if (value < min || value > max) {
    throw new Error(
      `${name} must be between ${min} and ${max} seconds (got ${value}). ` +
        'Out-of-range values are rejected with HTTP 400.'
    );
  }
  return value;
}

export function buildAutomaticLeave({
  recordingPermissionDeniedTimeout,
  waitingRoomTimeout,
  everyoneLeftTimeout,
  inCallRecordingTimeout,
} = {}) {
  const automaticLeave = {};

  if (
    assertRange(
      'recording_permission_denied_timeout',
      recordingPermissionDeniedTimeout,
      RECORDING_PERMISSION_TIMEOUT_MIN,
      RECORDING_PERMISSION_TIMEOUT_MAX
    ) !== undefined
  ) {
    automaticLeave.recording_permission_denied_timeout = recordingPermissionDeniedTimeout;
  }

  if (
    assertRange('waiting_room_timeout', waitingRoomTimeout, WAITING_ROOM_MIN, WAITING_ROOM_MAX_ZOOM) !==
    undefined
  ) {
    automaticLeave.waiting_room_timeout = waitingRoomTimeout;
  }

  if (assertRange('everyone_left_timeout', everyoneLeftTimeout, 60, 1800) !== undefined) {
    automaticLeave.everyone_left_timeout = everyoneLeftTimeout;
  }

  if (
    assertRange('in_call_recording_timeout', inCallRecordingTimeout, IN_CALL_RECORDING_MIN, 18_000) !==
    undefined
  ) {
    automaticLeave.in_call_recording_timeout = inCallRecordingTimeout;
  }

  return automaticLeave;
}

/**
 * @param {ReturnType<import('./client.js').createClient>} client
 * @param {object} opts
 * @param {string}  opts.meetingLink
 * @param {string}  opts.botName
 * @param {string} [opts.callbackUrl]
 * @param {boolean} [opts.videoRequired]
 * @param {object} [opts.automaticLeave]     already-built automatic_leave object
 * @param {object} [opts.zoomAuth]           { zakUrl } or { obfUrl } for an authenticated join
 * @param {object} [opts.recordingConfig]    e.g. transcript provider + retention
 * @param {object} [opts.customAttributes]   string values only
 */
export async function createZoomBot(client, opts) {
  const {
    meetingLink,
    botName = 'MeetStream Notetaker',
    callbackUrl,
    videoRequired = false,
    automaticLeave,
    zoomAuth,
    recordingConfig,
    customAttributes,
  } = opts;

  if (!meetingLink) throw new Error('createZoomBot requires a meetingLink.');
  if (!isZoomLink(meetingLink)) {
    throw new Error(`"${redactSecrets(meetingLink)}" does not look like a Zoom meeting link.`);
  }

  const body = {
    meeting_link: meetingLink,
    bot_name: botName,
    video_required: videoRequired,
  };

  if (callbackUrl) body.callback_url = callbackUrl;
  if (automaticLeave && Object.keys(automaticLeave).length > 0) {
    body.automatic_leave = automaticLeave;
  }
  if (recordingConfig && Object.keys(recordingConfig).length > 0) {
    body.recording_config = recordingConfig;
  }
  if (customAttributes && Object.keys(customAttributes).length > 0) {
    body.custom_attributes = customAttributes;
  }
  const zoom = buildZoomAuth(zoomAuth);
  if (zoom) body.zoom = zoom;

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
