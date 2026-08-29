/**
 * A deterministic stand-in for `fetch`.
 *
 * Some failure modes cannot be produced on demand against the real API without
 * either burning money (409 needs a duplicate live bot) or being a bad citizen
 * (429 needs you to hammer the endpoint). Those are reproduced here instead,
 * with response bodies and headers shaped exactly like the real ones, so the
 * client code under test is the real client code.
 *
 * Everything that CAN be demonstrated safely against production is, in
 * `--live` mode. See src/demos.js.
 */

const json = (status, body, headers = {}) =>
  new Response(body === null ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

/**
 * Build a fetch implementation for one scenario.
 * @param {object} spec
 * @param {(state:object) => Response} spec.respond
 * @returns {{ fetchImpl: typeof fetch, state: { calls: number, requests: object[] } }}
 */
export function mockTransport(spec) {
  const state = { calls: 0, requests: [] };
  const fetchImpl = async (url, init = {}) => {
    state.calls += 1;
    state.requests.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    return spec.respond(state, { url, init });
  };
  return { fetchImpl, state };
}

// ---------------------------------------------------------------------------
// Canned responses. Messages match what the API actually returns.
// ---------------------------------------------------------------------------

export const responses = {
  /** 400: the field name is in the message. Retrying identical input is pointless. */
  missingMeetingLink: () => json(400, { message: 'meeting_link is required.' }),

  /** 400: in_call_recording_timeout has a hard floor of 600 seconds. */
  timeoutTooLow: () =>
    json(400, { message: 'in_call_recording_timeout must be at least 600 seconds.' }),

  /** 401: no Authorization header at all. */
  noCredentials: () => json(401, { message: 'Authentication credentials were not provided.' }),

  /** 403: a key was sent, but it is not a valid one. */
  invalidToken: () => json(403, { message: 'Invalid token.' }),

  /** 404 */
  notFound: () => json(404, { message: 'Bot not found.' }),

  /** 409: a matching bot already exists for this meeting. */
  duplicateBot: () =>
    json(409, { message: 'A bot has already been created for this meeting link.' }),

  /** 429 with the server telling you exactly how long to wait. */
  rateLimited: (retryAfterSeconds = 2) =>
    json(429, { message: 'Request was throttled.' }, { 'Retry-After': String(retryAfterSeconds) }),

  /** 503, sometimes with Retry-After, sometimes not. */
  unavailable: (retryAfterSeconds) =>
    json(
      503,
      { message: 'Service temporarily unavailable.' },
      retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : {},
    ),

  serverError: () => json(500, { message: 'Internal server error.' }),

  /** 507: this Idempotency-Key was already processed. The first call succeeded. */
  idempotentReplay: (botId = 'bot_replayed_001') =>
    json(507, {
      message: 'Duplicate request. Returning the original result.',
      bot_id: botId,
      transcript_id: 'tr_replayed_001',
      meeting_url: 'https://meet.google.com/abc-defg-hij',
      status: 'joining',
    }),

  /** 202: still processing. Body is usually empty or a short message. */
  pending: () => json(202, { message: 'Transcript is still being processed.' }),

  botCreated: (botId = 'bot_live_001') =>
    json(201, {
      bot_id: botId,
      transcript_id: 'tr_live_001',
      meeting_url: 'https://meet.google.com/abc-defg-hij',
      status: 'joining',
    }),

  transcriptReady: () =>
    json(200, {
      // Segments use `speaker` + `transcript`. The text field is NOT `text`.
      transcript: [
        { speaker: 'Alice', transcript: 'Thanks everyone for joining.', start: 0.4, end: 2.9 },
        { speaker: 'Bob', transcript: 'Happy to be here.', start: 3.1, end: 4.6 },
      ],
    }),
};

/** Fails `failures` times with `failureResponse`, then succeeds. */
export function flakyThenOk(failures, failureResponse, successResponse) {
  return {
    respond: (state) =>
      state.calls <= failures ? failureResponse(state) : successResponse(state),
  };
}
