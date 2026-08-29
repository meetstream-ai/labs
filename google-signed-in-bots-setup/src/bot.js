/**
 * Creates a Google Meet bot that joins signed in to a real Google account
 * instead of as an anonymous guest.
 *
 *   POST /bots/create_bot
 *
 * The signed-in switch is the `google_meet` block:
 *
 *   "google_meet": {
 *     "login_required": true,
 *     "google_login_domain": "yourdomain.com",
 *     "sign_in_email": "bot@yourdomain.com",
 *     "strict_email": true
 *   }
 *
 * `google_login_domain` must already be configured under
 * Integrations -> Google Signed-In Bots, and `sign_in_email` must be one of the
 * logins registered under that domain.
 */

import { randomUUID } from 'node:crypto';

const GOOGLE_MEET_HOSTS = ['meet.google.com'];

export function isGoogleMeetLink(link) {
  try {
    const url = new URL(link);
    return GOOGLE_MEET_HOSTS.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * @param {ReturnType<import('./client.js').createClient>} client
 * @param {object} opts
 * @param {string}  opts.meetingLink
 * @param {string}  opts.botName
 * @param {string}  opts.googleLoginDomain
 * @param {string} [opts.signInEmail]     specific login to use; omit to let MeetStream pick one
 * @param {boolean} [opts.strictEmail]    fail rather than fall back to another login
 * @param {boolean} [opts.videoRequired]
 * @param {number}  [opts.waitingRoomTimeout] seconds, 60-600 on Google Meet
 * @param {string} [opts.callbackUrl]     per-bot webhook URL
 * @param {object} [opts.customAttributes] string values only
 */
export async function createSignedInBot(client, opts) {
  const {
    meetingLink,
    botName = 'MeetStream Signed-In Bot',
    googleLoginDomain,
    signInEmail,
    strictEmail = false,
    videoRequired = false,
    waitingRoomTimeout,
    callbackUrl,
    customAttributes,
  } = opts;

  if (!meetingLink) throw new Error('createSignedInBot requires a meetingLink.');
  if (!isGoogleMeetLink(meetingLink)) {
    throw new Error(
      `Signed-in bots are a Google Meet feature, but "${meetingLink}" is not a meet.google.com link.`
    );
  }
  if (!googleLoginDomain) {
    throw new Error(
      'createSignedInBot requires googleLoginDomain - the domain you registered under ' +
        'Integrations -> Google Signed-In Bots.'
    );
  }

  const googleMeet = {
    login_required: true,
    google_login_domain: googleLoginDomain,
  };
  if (signInEmail) googleMeet.sign_in_email = signInEmail;
  if (strictEmail) googleMeet.strict_email = true;

  const body = {
    meeting_link: meetingLink,
    bot_name: botName,
    video_required: videoRequired,
    google_meet: googleMeet,
  };

  if (callbackUrl) body.callback_url = callbackUrl;
  if (customAttributes && Object.keys(customAttributes).length > 0) {
    body.custom_attributes = customAttributes;
  }
  if (Number.isInteger(waitingRoomTimeout)) {
    body.automatic_leave = { waiting_room_timeout: waitingRoomTimeout };
  }

  const { data, replayed } = await client.request('/bots/create_bot', {
    method: 'POST',
    body,
    idempotencyKey: randomUUID(),
  });

  return { bot: data, replayed, request: body };
}
