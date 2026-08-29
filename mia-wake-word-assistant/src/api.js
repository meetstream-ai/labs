// Minimal MeetStream API client.
//
// Two rules that trip people up:
//   1. The auth header is `Authorization: Token <key>` - literally "Token", not "Bearer".
//   2. HTTP 507 means "idempotent replay": the original request already succeeded,
//      so it must be treated as success, not as an error.

const DEFAULT_BASE_URL = 'https://api.meetstream.ai/api/v1';

const STATUS_HELP = {
  400: 'MeetStream rejected the request body.',
  401: 'No API key was sent. Set MEETSTREAM_API_KEY in .env.',
  403: 'MeetStream denied the API key. Check MEETSTREAM_API_KEY.',
  404: 'MeetStream could not find that resource.',
  409: 'MeetStream treated this as a duplicate request.',
  429: 'Rate limited by MeetStream. Slow down and retry.',
  500: 'MeetStream had a server error. Retry shortly.',
  503: 'MeetStream is temporarily unavailable. Retry shortly.'
};

// Bot statuses that mean the session is over and there is nothing left to wait for.
const TERMINAL_BOT_STATUSES = new Set([
  'Stopped',
  'Kicked',
  'Denied',
  'NotAllowed',
  'Error',
  'MediaProcessing',
  'Done',
  'MediaExpired'
]);

export class MeetStreamError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'MeetStreamError';
    this.status = status;
    this.body = body;
  }
}

export function baseUrl() {
  const configured = process.env.MEETSTREAM_BASE_URL?.trim();
  return (configured || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/**
 * Perform one MeetStream API call.
 *
 * Returns { status, data, pending, replayed }.
 *   pending  -> HTTP 202, the resource is still being produced. Poll again.
 *   replayed -> HTTP 507, an identical idempotent request already succeeded.
 */
export async function request(path, options = {}) {
  const { apiKey, method = 'GET', body, query, idempotencyKey } = options;
  if (!apiKey) throw new Error('A MeetStream API key is required for every request.');

  const url = new URL(`${baseUrl()}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const headers = { Authorization: `Token ${apiKey}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (cause) {
    throw new Error(`Could not reach MeetStream at ${url.host}: ${cause.message}`);
  }

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (response.status === 507) return { status: 507, data, pending: false, replayed: true };
  if (response.status === 202) return { status: 202, data, pending: true, replayed: false };

  if (!response.ok) {
    const detail = data.message || data.error || (typeof data.raw === 'string' ? data.raw.slice(0, 300) : '');
    const help = STATUS_HELP[response.status] || `MeetStream returned HTTP ${response.status}.`;
    throw new MeetStreamError(response.status, detail ? `${help} ${detail}` : help, data);
  }

  return { status: response.status, data, pending: false, replayed: false };
}

/* ------------------------------------------------------------------ */
/* MIA (MeetStream Infrastructure Agent) configs                       */
/* ------------------------------------------------------------------ */

/** POST /mia - save a new agent config and return its agent_config_id. */
export async function createAgent(apiKey, config) {
  const { data } = await request('/mia', { apiKey, method: 'POST', body: config });
  const agentConfigId = readAgentId(data);
  if (!agentConfigId) {
    throw new Error(
      `MeetStream accepted the agent but returned no agent_config_id. Raw response: ${JSON.stringify(data)}`
    );
  }
  return { agentConfigId, raw: data };
}

/** GET /mia?agent_config_id=... - fetch one saved agent config. */
export async function getAgent(apiKey, agentConfigId) {
  const { data } = await request('/mia', { apiKey, query: { agent_config_id: agentConfigId } });
  return data.agent_config || data;
}

/** DELETE /mia?agent_config_id=... */
export async function deleteAgent(apiKey, agentConfigId) {
  const { data } = await request('/mia', {
    apiKey,
    method: 'DELETE',
    query: { agent_config_id: agentConfigId }
  });
  return data;
}

/** The API echoes agent ids in a couple of casings depending on the route. */
export function readAgentId(payload = {}) {
  return (
    payload.agent_config_id ||
    payload.AgentConfigID ||
    payload.agent_config?.agent_config_id ||
    payload.agent_config?.AgentConfigID ||
    null
  );
}

/* ------------------------------------------------------------------ */
/* Bots                                                                */
/* ------------------------------------------------------------------ */

/** POST /bots/create_bot */
export async function createBot(apiKey, payload, idempotencyKey) {
  const { data, replayed } = await request('/bots/create_bot', {
    apiKey,
    method: 'POST',
    body: payload,
    idempotencyKey
  });

  if (!data.bot_id) {
    if (replayed) {
      throw new Error(
        'MeetStream replayed an earlier identical create_bot request (HTTP 507) and did not repeat the bot id. ' +
          'The first bot is still running. Find it with GET /bots and remove it manually.'
      );
    }
    throw new Error('MeetStream created a bot but returned no bot_id, so it cannot be stopped safely.');
  }
  return data;
}

/** GET /bots/{id}/detail - returns null while MeetStream is still assembling the record. */
export async function getBotDetail(apiKey, botId) {
  const { data, pending } = await request(`/bots/${encodeURIComponent(botId)}/detail`, { apiKey });
  if (pending) return null;
  return data.bot_details || data;
}

/** GET /bots/{id}/remove_bot - note this really is a GET, not a POST or DELETE. */
export async function removeBot(apiKey, botId) {
  try {
    await request(`/bots/${encodeURIComponent(botId)}/remove_bot`, { apiKey });
  } catch (error) {
    // A 404 means the bot is already gone, which is the outcome we wanted.
    if (error instanceof MeetStreamError && error.status === 404) return;
    throw error;
  }
}

export function isTerminalStatus(status) {
  return TERMINAL_BOT_STATUSES.has(status);
}

/**
 * Poll GET /bots/{id}/detail and report every status change.
 * Resolves with the final status once the bot reaches a terminal state,
 * or when `shouldStop()` returns true.
 */
export async function watchBot(apiKey, botId, { intervalMs = 10_000, onStatus, shouldStop } = {}) {
  let lastStatus = null;
  while (!shouldStop?.()) {
    let detail = null;
    try {
      detail = await getBotDetail(apiKey, botId);
    } catch (error) {
      // Transient read failures should not kill the session. Report and keep polling.
      onStatus?.(`status check failed: ${error.message}`);
    }

    const status = detail?.Status || detail?.status;
    if (status && status !== lastStatus) {
      lastStatus = status;
      onStatus?.(status);
      if (isTerminalStatus(status)) return status;
    }

    await sleep(intervalMs, shouldStop);
  }
  return lastStatus;
}

/**
 * Sleep for `ms`, but wake early once `shouldStop()` turns true so Ctrl+C does
 * not have to wait out a full poll interval. The timers stay referenced on
 * purpose: they are what keeps the process alive between polls.
 */
export function sleep(ms, shouldStop) {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const step = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || shouldStop?.()) return resolve();
      setTimeout(step, Math.min(250, remaining));
    };
    step();
  });
}
