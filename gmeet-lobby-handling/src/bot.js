/**
 * Creating the Google Meet bot, with the lobby knobs set.
 *
 *   POST /bots/create_bot
 *
 * The lobby control is `automatic_leave.waiting_room_timeout` (seconds):
 * how long the bot waits to be admitted before giving up.
 *
 *   Range on Google Meet : 60 - 600   (out of range returns HTTP 400)
 *   Default              : 600
 *
 * If the timeout elapses the bot leaves and you get a terminal webhook whose
 * `bot_status` is "NotAllowed". If a host explicitly rejects it you get "Denied".
 *
 * Optionally joins signed in, which is the real fix for lobby friction:
 *
 *   "google_meet": { "login_required": true,
 *                    "google_login_domain": "yourdomain.com",
 *                    "sign_in_email": "bot@yourdomain.com" }
 */

import { randomUUID } from 'node:crypto';

export const WAITING_ROOM_MIN = 60;
export const WAITING_ROOM_MAX_GMEET = 600;

export function isGoogleMeetLink(link) {
  try {
    return new URL(link).hostname.toLowerCase() === 'meet.google.com';
  } catch {
    return false;
  }
}

export function assertWaitingRoomTimeout(seconds) {
  if (!Number.isInteger(seconds)) {
    throw new Error('waiting_room_timeout must be an integer number of seconds.');
  }
  if (seconds < WAITING_ROOM_MIN || seconds > WAITING_ROOM_MAX_GMEET) {
    throw new Error(
      `waiting_room_timeout must be between ${WAITING_ROOM_MIN} and ${WAITING_ROOM_MAX_GMEET} ` +
        `seconds on Google Meet (got ${seconds}). Out-of-range values are rejected with HTTP 400.`
    );
  }
  return seconds;
}

/**
 * @param {ReturnType<import('./client.js').createClient>} client
 * @param {object} opts
 * @param {string} opts.meetingLink
 * @param {string} opts.botName
 * @param {string} opts.callbackUrl
 * @param {number} opts.waitingRoomTimeout  seconds, 60-600
 * @param {boolean} [opts.videoRequired]
 * @param {object} [opts.signedIn]          { domain, email, strict }
 * @param {object} [opts.customAttributes]  string values only
 */
export async function createLobbyAwareBot(client, opts) {
  const {
    meetingLink,
    botName = 'MeetStream Notetaker',
    callbackUrl,
    waitingRoomTimeout,
    videoRequired = false,
    signedIn,
    customAttributes,
  } = opts;

  if (!meetingLink) throw new Error('createLobbyAwareBot requires a meetingLink.');
  if (!isGoogleMeetLink(meetingLink)) {
    throw new Error(
      `"${meetingLink}" is not a meet.google.com link. This template is about the Google Meet lobby.`
    );
  }
  if (!callbackUrl) {
    throw new Error(
      'createLobbyAwareBot requires a callbackUrl - without it no lifecycle webhooks arrive and ' +
        'there is nothing to react to.'
    );
  }

  assertWaitingRoomTimeout(waitingRoomTimeout);

  const body = {
    meeting_link: meetingLink,
    bot_name: botName,
    video_required: videoRequired,
    callback_url: callbackUrl,
    automatic_leave: {
      waiting_room_timeout: waitingRoomTimeout,
    },
  };

  if (signedIn?.domain) {
    body.google_meet = {
      login_required: true,
      google_login_domain: signedIn.domain,
    };
    if (signedIn.email) body.google_meet.sign_in_email = signedIn.email;
    if (signedIn.strict) body.google_meet.strict_email = true;
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

/** GET /bots/{id}/status - useful when a webhook is missed. */
export async function getBotStatus(client, botId) {
  const { data } = await client.request(`/bots/${encodeURIComponent(botId)}/status`);
  return data;
}

/** GET /bots/{id}/remove_bot - note this endpoint is a GET, not POST or DELETE. */
export async function removeBot(client, botId) {
  const { data } = await client.request(`/bots/${encodeURIComponent(botId)}/remove_bot`);
  return data;
}
