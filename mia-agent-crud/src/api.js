// Minimal MeetStream API client, scoped to the /mia routes.
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
  404: 'MeetStream could not find that agent config.',
  409: 'MeetStream treated this as a duplicate request.',
  429: 'Rate limited by MeetStream. Slow down and retry.',
  500: 'MeetStream had a server error. Retry shortly.',
  503: 'MeetStream is temporarily unavailable. Retry shortly.'
};

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
 *   pending  -> HTTP 202, still processing. Poll again.
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

/** POST /mia - save a new agent config and return its agent_config_id. */
export async function createAgent(apiKey, config) {
  const { data, replayed } = await request('/mia', { apiKey, method: 'POST', body: config });
  const agentConfigId = readAgentId(data);
  if (!agentConfigId) {
    if (replayed) {
      throw new Error(
        'MeetStream replayed an earlier identical create request (HTTP 507). The agent already exists. Run "list" to find it.'
      );
    }
    throw new Error(
      `MeetStream accepted the agent but returned no agent_config_id. Raw response: ${JSON.stringify(data)}`
    );
  }
  return { agentConfigId, raw: data };
}

/** GET /mia - every saved agent config on the account. */
export async function listAgents(apiKey) {
  const { data } = await request('/mia', { apiKey });
  return data.agent_configs || [];
}

/** GET /mia?agent_config_id=... - one saved agent config. */
export async function getAgent(apiKey, agentConfigId) {
  const { data } = await request('/mia', { apiKey, query: { agent_config_id: agentConfigId } });
  return data.agent_config || data;
}

/** PUT /mia - the body must carry agent_config_id alongside the changed blocks. */
export async function updateAgent(apiKey, agentConfigId, changes) {
  const { data } = await request('/mia', {
    apiKey,
    method: 'PUT',
    body: { agent_config_id: agentConfigId, ...changes }
  });
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
