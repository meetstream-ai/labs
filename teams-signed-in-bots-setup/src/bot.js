/**
 * Creates a Microsoft Teams bot that joins signed in to one of your registered
 * Microsoft 365 accounts instead of as an anonymous guest.
 *
 *   POST /bots/create_bot
 *
 * The signed-in switch is the `teams` block:
 *
 *   "teams": {
 *     "login_required": true,
 *     "teams_login_domain": "bots.acme.com",
 *     "sign_in_email": "bot1@bots.acme.com",   optional: pin one account
 *     "strict_email": true                      optional, API default true
 *   }
 *
 * strict_email only matters with sign_in_email: true fails the request if that
 * account is busy or unhealthy, false falls back to any available account in
 * the domain. Without sign_in_email MeetStream picks any free account.
 *
 * Things that surprise people:
 *   - A malformed `teams` block is DROPPED SILENTLY and the bot joins as a guest.
 *     That is why this module validates the block locally before sending it.
 *   - The Microsoft account's own display name and profile picture are used.
 *     `bot_name` and `bot_image_url` are not applied to a signed-in Teams bot.
 *   - One account runs one bot at a time. N concurrent bots need N accounts.
 *   - Work or school Teams (teams.microsoft.com) only, not Teams for personal
 *     use (teams.live.com).
 */

import { randomUUID } from 'node:crypto';

import { assertDomain } from './domains.js';
import { assertEmail, emailDomain } from './logins.js';

export const WAITING_ROOM_MIN = 60;
export const WAITING_ROOM_MAX_TEAMS = 1800;

const WORK_TEAMS_HOST = /(^|\.)teams\.(microsoft\.com|microsoft\.us|cloud\.microsoft)$/i;
const PERSONAL_TEAMS_HOST = /(^|\.)teams\.live\.com$/i;

/** Returns null for a usable work/school Teams link, otherwise the reason it is not. */
export function teamsLinkProblem(link) {
  let host;
  try {
    host = new URL(link).hostname;
  } catch {
    return `"${link}" is not a valid URL.`;
  }
  if (PERSONAL_TEAMS_HOST.test(host)) {
    return (
      `${host} is Teams for personal use. Signed-in bots only work with Microsoft 365 work or ` +
      'school Teams meetings (teams.microsoft.com).'
    );
  }
  if (!WORK_TEAMS_HOST.test(host)) {
    return `"${link}" is not a Microsoft Teams meeting link (expected teams.microsoft.com).`;
  }
  return null;
}

/**
 * Build and validate the create_bot body. Pure, so --dry-run can print it.
 *
 * @param {object} opts
 * @param {string}  opts.meetingLink
 * @param {string}  opts.teamsLoginDomain
 * @param {string} [opts.signInEmail]      pin one account
 * @param {boolean}[opts.strictEmail]      omit to take the API default (true)
 * @param {string} [opts.botName]          only shown if the bot ever joins as a guest
 * @param {boolean} [opts.videoRequired]   off by default; video is opt-in
 * @param {string} [opts.videoLayout]      "speaker_view" (default) or "grid_view"
 * @param {number} [opts.waitingRoomTimeout] seconds, 60-1800 on Teams
 * @param {string} [opts.callbackUrl]
 */
export function buildSignedInBotBody(opts) {
  const {
    meetingLink,
    teamsLoginDomain,
    signInEmail,
    strictEmail,
    botName,
    videoRequired = false,
    videoLayout,
    waitingRoomTimeout,
    callbackUrl,
  } = opts;

  if (!meetingLink) throw new Error('A Teams meeting link is required.');
  const problem = teamsLinkProblem(meetingLink);
  if (problem) throw new Error(problem);

  const teams = {
    login_required: true,
    teams_login_domain: assertDomain(teamsLoginDomain),
  };

  const warnings = [];

  if (signInEmail) {
    teams.sign_in_email = assertEmail(signInEmail);
    if (emailDomain(signInEmail) !== teams.teams_login_domain) {
      warnings.push(
        `sign_in_email ${teams.sign_in_email} is not on ${teams.teams_login_domain}. It must be an ` +
          'account registered under that login domain, or create_bot returns 404.'
      );
    }
  }
  if (typeof strictEmail === 'boolean') {
    teams.strict_email = strictEmail;
    if (!signInEmail) {
      warnings.push('strict_email has no effect without sign_in_email.');
    }
  }

  if (waitingRoomTimeout !== undefined) {
    if (
      !Number.isInteger(waitingRoomTimeout) ||
      waitingRoomTimeout < WAITING_ROOM_MIN ||
      waitingRoomTimeout > WAITING_ROOM_MAX_TEAMS
    ) {
      throw new Error(
        `waiting_room_timeout must be ${WAITING_ROOM_MIN}-${WAITING_ROOM_MAX_TEAMS} seconds on Teams.`
      );
    }
  }

  const body = {
    meeting_link: meetingLink,
    video_required: videoRequired,
    teams,
  };
  if (botName) body.bot_name = botName;
  if (callbackUrl) body.callback_url = callbackUrl;
  if (waitingRoomTimeout !== undefined) {
    body.automatic_leave = { waiting_room_timeout: waitingRoomTimeout };
  }

  // Video is off by default, and `false` is sent explicitly because the REST
  // API treats an omitted `video_required` as true. When video IS on, pick the
  // layout explicitly: the API default is `grid_view`, and speaker view follows
  // the active speaker, which is what people want for review and clipping.
  // Per-participant video (`video_separate_streams`) is never set here.
  if (body.video_required) {
    body.recording_config = body.recording_config || {};
    body.recording_config.video_layout =
      String(videoLayout || 'speaker_view').toLowerCase() === 'grid_view'
        ? 'grid_view'
        : 'speaker_view';
  }

  return { body, warnings };
}

export async function createSignedInBot(client, opts) {
  const { body, warnings } = buildSignedInBotBody(opts);

  const { data, replayed, dryRun } = await client.request('/bots/create_bot', {
    method: 'POST',
    body,
    idempotencyKey: randomUUID(),
    // Do not retry 429 here: for a signed-in Teams bot it means every account
    // in the domain is already running a bot, which a few seconds will not fix.
    retryOn: new Set([500, 502, 503, 504]),
  });

  return { bot: data, replayed, dryRun, request: body, warnings };
}
