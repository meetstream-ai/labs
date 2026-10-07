/**
 * "How many signed-in logins do I need?"
 *
 * Google limits how many meetings a single account can join at the same time.
 * MeetStream distributes signed-in bots across a domain's logins round-robin,
 * so the documented rule of thumb is:
 *
 *   logins = peak concurrent Google Meet sessions / 20
 *
 * Round up, and leave headroom for spikes.
 * Source: https://docs.meetstream.ai/guides/app-integrations/google-signed-in-bots
 */

export const SESSIONS_PER_LOGIN = 20;

/**
 * @param {number} peakConcurrentSessions
 * @param {object} [opts]
 * @param {number} [opts.perLogin]  sessions per login (default 20)
 * @param {number} [opts.headroom]  fractional buffer, e.g. 0.2 for +20%
 */
export function requiredLogins(peakConcurrentSessions, { perLogin = SESSIONS_PER_LOGIN, headroom = 0 } = {}) {
  if (!Number.isFinite(peakConcurrentSessions) || peakConcurrentSessions < 0) {
    throw new Error('peak concurrent sessions must be a non-negative number.');
  }
  if (!Number.isFinite(perLogin) || perLogin <= 0) {
    throw new Error('sessions per login must be a positive number.');
  }
  if (!Number.isFinite(headroom) || headroom < 0) {
    throw new Error('headroom must be a non-negative number.');
  }

  const base = Math.ceil(peakConcurrentSessions / perLogin);
  const withHeadroom = Math.ceil(base * (1 + headroom));

  return {
    peakConcurrentSessions,
    perLogin,
    headroom,
    minimumLogins: base,
    recommendedLogins: Math.max(withHeadroom, base),
    capacityAtRecommended: Math.max(withHeadroom, base) * perLogin,
  };
}

/**
 * Compare the rule of thumb against what is actually configured.
 * `logins` is the array returned by GET /google-logins (or a domain's `logins`).
 */
export function assessCapacity(logins, peakConcurrentSessions, opts = {}) {
  const plan = requiredLogins(peakConcurrentSessions, opts);
  const total = logins.length;
  const active = logins.filter((l) => l.is_active !== false).length;
  const inUse = logins.reduce((sum, l) => sum + (Number(l.active_sessions) || 0), 0);

  return {
    ...plan,
    configuredLogins: total,
    activeLogins: active,
    sessionsInUseRightNow: inUse,
    currentCapacity: active * plan.perLogin,
    shortfall: Math.max(plan.recommendedLogins - active, 0),
    sufficient: active >= plan.recommendedLogins,
  };
}
