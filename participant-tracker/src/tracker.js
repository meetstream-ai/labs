/**
 * Attendance state built from participant lifecycle events.
 *
 * Two sources feed this tracker:
 *
 *   1. `participant_events.join` / `participant_events.leave` webhooks, which
 *      MeetStream POSTs to the `realtime_endpoints` URL you register on
 *      create_bot. These carry a nested envelope:
 *
 *        {
 *          "event": "participant_events.leave",
 *          "timestamp": "2026-05-26T10:11:14.990Z",
 *          "data": {
 *            "data": {
 *              "action": "leave",
 *              "participant": { "id": "...", "name": "...", "full_name": "...", "platform": "gmeet" },
 *              "timestamp": { "relative": 50.792, "absolute": "2026-05-26T10:11:14.990Z" }
 *            },
 *            "bot": { "id": "...", "metadata": {} }
 *          },
 *          "custom_attributes": {}
 *        }
 *
 *      Note there is no top-level `bot_id` on these - it is at `data.bot.id`.
 *
 *   2. `GET /bots/{bot_id}/get_participants`, a top-level JSON array of
 *      `{ deviceId, displayName, fullName, profilePicture, status,
 *         humanized_status, streamIds, lastUpdated, parentDeviceId }`.
 *      This is the roster snapshot and is used to reconcile anyone whose
 *      join event was missed (for example if the server started late).
 */

export class AttendanceTracker {
  constructor() {
    /** @type {Map<string, { id: string, name: string, platform: string|null, sessions: Array<{joinedAt: string|null, leftAt: string|null, relativeJoin: number|null, relativeLeave: number|null}>, seenInRoster: boolean, rosterStatus: string|null }>} */
    this.participants = new Map();
    /** @type {Array<{ event: string, name: string, at: string|null, relative: number|null }>} */
    this.log = [];
    this.meetingStartedAt = null;
    this.meetingEndedAt = null;
    /** @type {Array<{ event: string, status: string|null, at: string }>} */
    this.botLifecycle = [];
  }

  #entry(id, name, platform) {
    const key = id || `name:${name}`;
    if (!this.participants.has(key)) {
      this.participants.set(key, {
        id: id || null,
        name: name || 'Unknown',
        platform: platform || null,
        sessions: [],
        seenInRoster: false,
        rosterStatus: null,
      });
    }
    const entry = this.participants.get(key);
    // Prefer a real name over a placeholder if a later event carries one.
    if (name && name !== 'Unknown' && (entry.name === 'Unknown' || !entry.name)) entry.name = name;
    if (platform && !entry.platform) entry.platform = platform;
    return entry;
  }

  /**
   * Feed a `participant_events.*` webhook body.
   * @param {any} payload
   * @returns {{ action: string, name: string } | null} what was recorded, for logging
   */
  applyParticipantEvent(payload) {
    const inner = payload?.data?.data;
    if (!inner) return null;

    const action = inner.action || (payload.event || '').split('.').pop();
    const p = inner.participant || {};
    const name = p.full_name || p.name || 'Unknown';
    const id = p.id || null;
    const absolute = inner.timestamp?.absolute || payload.timestamp || null;
    const relative = Number.isFinite(Number(inner.timestamp?.relative))
      ? Number(inner.timestamp.relative)
      : null;

    const entry = this.#entry(id, name, p.platform);

    if (action === 'join') {
      entry.sessions.push({
        joinedAt: absolute,
        leftAt: null,
        relativeJoin: relative,
        relativeLeave: null,
      });
    } else if (action === 'leave') {
      const open = [...entry.sessions].reverse().find((s) => s.leftAt === null);
      if (open) {
        open.leftAt = absolute;
        open.relativeLeave = relative;
      } else {
        // Leave without a matching join - we started watching mid-meeting.
        entry.sessions.push({
          joinedAt: null,
          leftAt: absolute,
          relativeJoin: null,
          relativeLeave: relative,
        });
      }
    } else {
      return null;
    }

    this.log.push({ event: action, name: entry.name, at: absolute, relative });
    return { action, name: entry.name };
  }

  /**
   * Feed a bot lifecycle webhook body (`bot.inmeeting`, `bot.stopped`, ...).
   * The envelope key is `event` and `bot_id` / `bot_status` are top level.
   */
  applyBotEvent(payload) {
    const event = payload?.event;
    if (typeof event !== 'string') return null;
    const at = payload.timestamp || new Date().toISOString();
    this.botLifecycle.push({ event, status: payload.bot_status ?? null, at });
    if (event === 'bot.recording' && !this.meetingStartedAt) this.meetingStartedAt = at;
    if (event === 'bot.inmeeting' && !this.meetingStartedAt) this.meetingStartedAt = at;
    if (event === 'bot.stopped') this.meetingEndedAt = at;
    return { event, status: payload.bot_status ?? null };
  }

  /**
   * Reconcile against the roster returned by GET /bots/{id}/get_participants.
   * @param {any} roster top-level array of participant objects
   */
  applyRoster(roster) {
    if (!Array.isArray(roster)) return 0;
    let added = 0;
    for (const p of roster) {
      const id = p.deviceId || null;
      const name = p.fullName || p.displayName || 'Unknown';
      const key = id || `name:${name}`;
      const existed = this.participants.has(key);
      const entry = this.#entry(id, name, null);
      entry.seenInRoster = true;
      entry.rosterStatus = p.humanized_status ?? (p.status !== undefined ? String(p.status) : null);
      if (!existed) added += 1;
    }
    return added;
  }

  /**
   * Build the final attendance report.
   * @param {{ botId: string, fallbackStart?: string|null, fallbackEnd?: string|null }} opts
   */
  buildReport({ botId, fallbackStart = null, fallbackEnd = null }) {
    const start = this.meetingStartedAt || fallbackStart;
    const end = this.meetingEndedAt || fallbackEnd;

    const rows = [...this.participants.values()].map((p) => {
      let attendedSeconds = 0;
      let complete = p.sessions.length > 0;

      for (const s of p.sessions) {
        const from = s.joinedAt || start;
        const to = s.leftAt || end;
        if (from && to) {
          const ms = new Date(to).getTime() - new Date(from).getTime();
          if (Number.isFinite(ms) && ms > 0) attendedSeconds += ms / 1000;
        }
        if (!s.joinedAt || !s.leftAt) complete = false;
      }

      const firstJoin = p.sessions.map((s) => s.joinedAt).filter(Boolean).sort()[0] || null;
      const lastLeave = p.sessions
        .map((s) => s.leftAt)
        .filter(Boolean)
        .sort()
        .pop() || null;

      return {
        id: p.id,
        name: p.name,
        platform: p.platform,
        sessions: p.sessions,
        session_count: p.sessions.length,
        first_join: firstJoin,
        last_leave: lastLeave,
        attended_seconds: p.sessions.length > 0 ? attendedSeconds : null,
        attendance_exact: complete,
        seen_in_roster: p.seenInRoster,
        roster_status: p.rosterStatus,
        still_present: p.sessions.some((s) => s.joinedAt && !s.leftAt),
      };
    });

    rows.sort((a, b) => {
      const aTime = a.attended_seconds ?? -1;
      const bTime = b.attended_seconds ?? -1;
      if (aTime !== bTime) return bTime - aTime;
      return String(a.name).localeCompare(String(b.name));
    });

    const meetingSeconds =
      start && end ? Math.max(0, (new Date(end).getTime() - new Date(start).getTime()) / 1000) : null;

    return {
      bot_id: botId,
      generated_at: new Date().toISOString(),
      meeting_started_at: start,
      meeting_ended_at: end,
      meeting_seconds: Number.isFinite(meetingSeconds) ? meetingSeconds : null,
      participant_count: rows.length,
      join_leave_events: this.log.length,
      bot_lifecycle: this.botLifecycle,
      participants: rows,
      event_log: this.log,
    };
  }
}

/**
 * Rebuild a tracker from `bot_details.participant_events` on
 * `GET /bots/{bot_id}/detail`, for reporting on a meeting that already ended.
 *
 * The stored events use the same `{ action, participant, timestamp }` inner
 * shape as the live webhook, so they are replayed through the same code path.
 *
 * @param {any} participantEvents
 * @returns {AttendanceTracker}
 */
export function trackerFromStoredEvents(participantEvents) {
  const tracker = new AttendanceTracker();
  const list = Array.isArray(participantEvents)
    ? participantEvents
    : Array.isArray(participantEvents?.events)
      ? participantEvents.events
      : [];

  for (const raw of list) {
    // Accept either the bare inner shape or the full webhook envelope.
    const wrapped = raw?.data?.data ? raw : { event: `participant_events.${raw?.action}`, data: { data: raw } };
    tracker.applyParticipantEvent(wrapped);
  }
  return tracker;
}
