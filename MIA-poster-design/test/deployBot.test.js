import assert from 'node:assert/strict';
import test from 'node:test';
import { CANVA_MCP_URL, createBotPayload, POSTER_TOOL, redact, removeBot, SYSTEM_PROMPT, validateAgentConfig, WAKE_WORDS } from '../src/deployBot.js';
import { settings } from '../src/index.js';

const validAgent = {
  AgentConfigID: 'agent-1',
  AgentName: 'Poster Agent',
  Mode: 'pipeline',
  Model: { provider: 'openai', model: 'gpt-4.1-mini', system_prompt: SYSTEM_PROMPT },
  Transcriber: { provider: 'deepgram', model: 'nova-3' },
  WakeWord: { enabled: true, words: WAKE_WORDS, timeout: 30 },
  Agent: {
    response_type: 'chat',
    response_modality: 'chat',
    mcp_servers: [{ url: CANVA_MCP_URL, allowed_tools: [POSTER_TOOL] }]
  }
};

test('poster prompt acts once and limits output', () => {
  assert.match(SYSTEM_PROMPT, /event type is the only required field/);
  assert.match(SYSTEM_PROMPT, /Never ask a question/);
  assert.match(SYSTEM_PROMPT, /return no response and wait/);
  assert.match(SYSTEM_PROMPT, /call generate-design exactly once/);
  assert.match(SYSTEM_PROMPT, /up to the first three real Canva results/);
});

test('environment validation accepts the documented values', () => {
  const result = settings({
    MEETSTREAM_API_KEY: 'key',
    MEETSTREAM_AGENT_CONFIG_ID: 'agent',
    MEETING_LINK: 'https://meet.google.com/abc-defg-hij',
    NGROK_AUTHTOKEN: 'token',
    PORT: '3000'
  });
  assert.equal(result.port, 3000);
  assert.throws(() => settings({}), /Fill in/);
});

test('MIA config requires pipeline, chat output, wake words, nova-3, and focused MCP tool', () => {
  assert.equal(validateAgentConfig(validAgent).url, CANVA_MCP_URL);
  assert.equal(validateAgentConfig({ ...validAgent, Agent: { ...validAgent.Agent, response_type: undefined } }).url, CANVA_MCP_URL);
  assert.throws(() => validateAgentConfig({ ...validAgent, Agent: { ...validAgent.Agent, response_type: 'voice' } }), /Stage 5/);
  assert.throws(() => validateAgentConfig({ ...validAgent, Mode: 'realtime' }), /Stage 4/);
  assert.throws(() => validateAgentConfig({ ...validAgent, Model: { provider: 'openai', model: 'gpt-4.1' } }), /Stage 4/);
  assert.throws(() => validateAgentConfig({ ...validAgent, Model: { ...validAgent.Model, system_prompt: 'old prompt' } }), /out of date/);
  assert.throws(() => validateAgentConfig({ ...validAgent, Agent: { ...validAgent.Agent, response_modality: 'voice' } }), /Stage 5/);
  assert.throws(() => validateAgentConfig({ ...validAgent, WakeWord: { enabled: false } }), /Stage 6/);
  assert.throws(() => validateAgentConfig({ ...validAgent, Transcriber: { provider: 'deepgram', model: 'nova-2' } }), /Stage 7/);
  assert.throws(() => validateAgentConfig({ ...validAgent, Agent: { ...validAgent.Agent, mcp_servers: [] } }), /Stage 8/);
  assert.throws(() => validateAgentConfig({ ...validAgent, Agent: { ...validAgent.Agent, mcp_servers: [{ url: 'https://design.example/mcp', allowed_tools: [POSTER_TOOL] }] } }), /Stage 8/);
  assert.throws(() => validateAgentConfig({ ...validAgent, Agent: { ...validAgent.Agent, mcp_servers: [{ url: CANVA_MCP_URL, allowed_tools: [POSTER_TOOL, 'extra'] }] } }), /Stage 9/);
});

test('hosted MIA payload delegates its bridge to agent_config_id', () => {
  const payload = createBotPayload({
    meetingLink: 'https://meet.google.com/a',
    agentConfigId: 'agent',
    callbackUrl: 'https://hooks.example/webhook'
  });
  assert.equal(payload.socket_connection_url, undefined);
  assert.equal(payload.live_audio_required, undefined);
});

test('secret redaction removes nested credentials and URL tokens', () => {
  const output = JSON.stringify(redact({
    headers: { Authorization: 'Bearer abc123', 'X-API-Key': 'secret' },
    url: 'https://example.test/mcp?token=private'
  }));
  assert.doesNotMatch(output, /abc123|secret|private/);
  assert.match(output, /\[REDACTED\]/);
});

test('graceful removal retries while joining and waits for confirmation', async (context) => {
  const originalFetch = global.fetch;
  let removals = 0;
  context.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/remove_bot')) {
      assert.equal(options.method, undefined);
      removals++;
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ bot_details: { Status: 'Joining' } }) };
  };
  let waits = 0;
  await removeBot('key', 'exact-bot', async (botId) => {
    assert.equal(botId, 'exact-bot');
    if (waits++ === 0) throw new Error('not terminal');
  });
  assert.equal(removals, 2);
});
