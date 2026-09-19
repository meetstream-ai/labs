const API = 'https://api.meetstream.ai/api/v1';
export const CANVA_MCP_URL = 'https://mcp.canva.com/mcp';
export const POSTER_TOOL = 'generate-design';
export const WAKE_WORDS = [
  'hey mia',
  'okay mia',
  'ok mia',
  'hey assistant',
  'okay assistant',
  'hey bot'
];

const SYSTEM_PROMPT = `You are MIA Poster Design Bot. Your job is to generate posters, not interview users.

Keep one event brief from the conversation. Ignore wake phrases as content. The event type is the only required field. As soon as the event type plus any one detail is known, or the user asks to create, proceed, or generate, you MUST call ${POSTER_TOOL} exactly once with design_type "poster". Never ask a question, request confirmation, summarize the brief, or announce progress. If a speech fragment is incomplete and the minimum rule is not met, return no response and wait.

Missing text, date, time, venue, colors, imagery, audience, and style are optional: omit them or choose tasteful design defaults. Relative dates such as "tomorrow" are valid. You may create generic invitation copy, but never invent factual event details or change user-provided wording.

The tool query must include every known fact and strong art direction: exact copy, palette, typography, hierarchy, composition, motifs, contrast, legibility, and safe margins. Request three polished, clearly different concepts. Your only chat response is either up to the first three real Canva results with label, Canva URL, and thumbnail URL, or one concise tool error. Never claim generation succeeded without tool results.`;

const field = (object, name) => object?.[name] ?? object?.[name[0].toUpperCase() + name.slice(1)];

export function redact(value) {
  if (typeof value === 'string') return value
    .replace(/(authorization["']?\s*[:=]\s*["']?)(?:Bearer |Token )?[^"',\s}]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:key|token|api_key)=)[^&\s]+/gi, '$1[REDACTED]');
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /authorization|api.?key|token|secret|cookie/i.test(key) ? '[REDACTED]' : redact(item)
  ]));
}

function apiError(stage, status, data = {}) {
  const detail = data.message || data.error || `HTTP ${status}`;
  return new Error(`Stage ${stage} failed: ${redact(String(detail))}`);
}

async function request(path, apiKey, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Token ${apiKey}`,
      ...(options.body && { 'Content-Type': 'application/json' }),
      ...options.headers
    }
  }).catch((error) => {
    throw new Error(`Could not reach MeetStream: ${error.message}`);
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

export async function fetchAgentConfig(apiKey, agentConfigId) {
  const { response, data } = await request('/mia', apiKey);
  if (!response.ok) throw apiError(1, response.status, data);
  const agent = data.agent_configs?.find((item) => item.AgentConfigID === agentConfigId);
  if (!agent) throw new Error('Stage 2 failed: MEETSTREAM_AGENT_CONFIG_ID does not match a saved Hosted Agent.');
  return agent;
}

export function validateAgentConfig(agent, expectedMcpUrl = CANVA_MCP_URL) {
  const config = field(agent, 'agent') || {};
  const transcriber = field(agent, 'transcriber') || {};
  const model = field(agent, 'model') || {};
  const wakeWord = field(agent, 'wakeWord') || agent.WakeWord || {};
  if (String(agent.Mode).toLowerCase() !== 'pipeline' || model.provider !== 'openai' || model.model !== 'gpt-4.1-mini') {
    throw new Error('Stage 4 failed: MIA must use Pipeline mode with the low-cost OpenAI gpt-4.1-mini model.');
  }
  if (model.system_prompt?.trim() !== SYSTEM_PROMPT.trim()) {
    throw new Error('Stage 4 failed: the Hosted Agent system prompt is out of date.');
  }
  if (config.response_modality !== 'chat' || (config.response_type != null && config.response_type !== 'chat')) {
    throw new Error('Stage 5 failed: the agent response must be chat.');
  }
  if (!wakeWord.enabled || !WAKE_WORDS.every((word) => wakeWord.words?.includes(word)) || wakeWord.timeout !== 30) {
    throw new Error('Stage 6 failed: native wake words must be enabled with the required words and a 30-second timeout.');
  }
  if (transcriber.provider !== 'deepgram' || transcriber.model !== 'nova-3') {
    throw new Error('Stage 7 failed: transcription must use Deepgram nova-3.');
  }
  const server = (config.mcp_servers || []).find((item) => item.allowed_tools?.includes(POSTER_TOOL));
  if (!server) throw new Error(`Stage 8 failed: no MCP server allows ${POSTER_TOOL}.`);
  let endpoint;
  try {
    endpoint = new URL(server.url);
  } catch {
    throw new Error('Stage 8 failed: the MCP endpoint is not a valid URL.');
  }
  if (endpoint.protocol !== 'https:') throw new Error('Stage 8 failed: the MCP endpoint must use HTTPS.');
  if (endpoint.href.replace(/\/$/, '') !== expectedMcpUrl.replace(/\/$/, '')) {
    throw new Error(`Stage 8 failed: the MCP endpoint must be ${expectedMcpUrl}.`);
  }
  if (server.allowed_tools.length !== 1 || server.allowed_tools[0] !== POSTER_TOOL) {
    throw new Error(`Stage 9 failed: allowed_tools must contain only ${POSTER_TOOL}.`);
  }
  return server;
}

export function createBotPayload({ agentConfigId, meetingLink, callbackUrl }) {
  return {
    meeting_link: meetingLink,
    bot_name: 'MIA Poster Design Bot',
    bot_message: "Hi, I'm MIA Poster Design Bot. Tell me about your event, then ask me to create poster concepts.",
    video_required: false,
    agent_config_id: agentConfigId,
    callback_url: callbackUrl
  };
}

export async function deployBot(config) {
  const payload = createBotPayload(config);
  const { response, data } = await request('/bots/create_bot', config.apiKey, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw apiError(10, response.status, data);
  if (!data.bot_id) throw new Error('Stage 10 failed: MeetStream did not return a bot_id.');
  return data;
}

export async function removeBot(apiKey, botId, waitForTerminal) {
  if (!botId || !waitForTerminal) throw new Error('Bot removal needs the exact bot ID and webhook confirmation.');
  const path = `/bots/${encodeURIComponent(botId)}`;
  for (let attempt = 0; attempt < 22; attempt++) {
    const { response, data } = await request(`${path}/remove_bot`, apiKey);
    if ([404, 409].includes(response.status)) return;
    if (!response.ok) throw apiError(17, response.status, data);
    try {
      await waitForTerminal(botId, 4000);
      return;
    } catch {
      const detail = await request(`${path}/detail`, apiKey);
      if (detail.response.status === 404) return;
      const bot = detail.data.bot_details || detail.data;
      const timeline = bot.StatusTimeline || {};
      if (timeline.Stopped?.status || timeline.Kicked?.status || ['Stopped', 'Done', 'MediaProcessing', 'MediaExpired'].includes(bot.Status)) return;
    }
  }
  throw new Error('Stage 17 failed: MeetStream did not confirm bot removal after 90 seconds.');
}

export { SYSTEM_PROMPT };
