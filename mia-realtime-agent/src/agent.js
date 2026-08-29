// Builds the realtime-mode MIA config that gets POSTed to /mia.
//
// Realtime mode replaces the three pipeline layers with a single speech-to-speech
// model. There is no `voice`, `transcriber`, or `wake_word` block: the realtime
// model hears audio and emits audio itself, which is where the latency win comes from.
//
// For OpenAI realtime models the voice is selected inside the `model` block.

import { optional } from './env.js';

// Voices accepted by OpenAI realtime models.
export const OPENAI_REALTIME_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse'
];

const DEFAULT_SYSTEM_PROMPT =
  'You are MIA, a spoken assistant in a live meeting. Answer in one or two short sentences so the reply ' +
  'lands before the conversation moves on. Never read out markdown or code. Say you do not know rather than guessing.';

const DEFAULT_FIRST_MESSAGE = 'Hi, I am MIA. I am listening.';

export function buildRealtimeAgentConfig() {
  const provider = optional('MIA_REALTIME_PROVIDER', 'openai');
  const model = optional('MIA_REALTIME_MODEL', 'gpt-4o-realtime-preview');
  const voice = optional('MIA_REALTIME_VOICE', 'nova');

  if (provider === 'openai' && !OPENAI_REALTIME_VOICES.includes(voice)) {
    throw new Error(
      `MIA_REALTIME_VOICE "${voice}" is not an OpenAI realtime voice. Pick one of: ${OPENAI_REALTIME_VOICES.join(', ')}.`
    );
  }

  return {
    agent_name: optional('MIA_AGENT_NAME', 'Realtime Voice Assistant'),
    mode: 'realtime',
    model: {
      provider,
      model,
      voice,
      system_prompt: optional('MIA_SYSTEM_PROMPT', DEFAULT_SYSTEM_PROMPT)
    },
    agent: {
      response_type: 'voice',
      first_message: optional('MIA_FIRST_MESSAGE', DEFAULT_FIRST_MESSAGE),
      mcp_servers: []
    }
  };
}

/** Reads back a saved config for display. The GET route returns PascalCase keys. */
export function describeAgent(agent = {}) {
  const model = agent.Model || agent.model || {};
  const inner = agent.Agent || agent.agent || {};
  return [
    `  mode         ${agent.Mode || agent.mode || 'unknown'}`,
    `  model        ${model.provider || '-'} ${model.model || ''}`.trimEnd(),
    `  voice        ${model.voice || '-'}`,
    `  responds as  ${inner.response_type || inner.response_modality || '-'}`
  ].join('\n');
}

/** Guard against pointing this template at a pipeline agent by mistake. */
export function assertRealtime(agent = {}) {
  const mode = agent.Mode || agent.mode;
  if (mode && mode !== 'realtime') {
    throw new Error(
      `MEETSTREAM_AGENT_CONFIG_ID points at a "${mode}" agent. This template expects a realtime agent. ` +
        'Use the mia-voice-agent-pipeline template for pipeline agents, or unset the id to create a realtime one.'
    );
  }
}
