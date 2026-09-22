// Builds the pipeline-mode MIA config that gets POSTed to /mia.
//
// Pipeline mode chains three independently swappable layers:
//
//   transcriber  speech in  -> text        (Deepgram, AssemblyAI, Sarvam, JigsawStack, MeetStream)
//   model        text       -> text        (the LLM that decides what to say)
//   voice        text       -> speech out  (the TTS voice heard in the meeting)
//
// Every layer below is driven from .env so you can swap one without touching the others.

import { optional } from './env.js';

const DEFAULT_SYSTEM_PROMPT =
  'You are MIA, a spoken assistant sitting in a live meeting. Keep answers short enough to say out loud, ' +
  'usually one or two sentences. Speak plainly, never read out markdown or code, and say you do not know ' +
  'rather than guessing.';

const DEFAULT_FIRST_MESSAGE = 'Hi, I am MIA. Ask me anything while the meeting runs.';

export function buildPipelineAgentConfig() {
  return {
    agent_name: optional('MIA_AGENT_NAME', 'Pipeline Voice Assistant'),
    mode: 'pipeline',

    // Layer 2: the LLM. Provider and model must both be enabled in your
    // MeetStream dashboard integrations.
    model: {
      provider: optional('MIA_MODEL_PROVIDER', 'openai'),
      model: optional('MIA_MODEL', 'gpt-4.1'),
      system_prompt: optional('MIA_SYSTEM_PROMPT', DEFAULT_SYSTEM_PROMPT)
    },

    // Layer 3: text to speech. Pipeline mode only - realtime models carry their own voice.
    voice: {
      provider: optional('MIA_VOICE_PROVIDER', 'openai'),
      voice_id: optional('MIA_VOICE_ID', 'nova')
    },

    // Layer 1: speech to text. Pipeline mode only.
    transcriber: {
      provider: optional('MIA_TRANSCRIBER_PROVIDER', 'deepgram'),
      model: optional('MIA_TRANSCRIBER_MODEL', 'nova-3'),
      language: optional('MIA_TRANSCRIBER_LANGUAGE', 'en')
    },

    // response_type "voice" makes the agent speak. Use "chat" to post in meeting
    // chat instead, or "action" for tool-only agents that produce no utterance.
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
  const voice = agent.Voice || agent.voice || {};
  const transcriber = agent.Transcriber || agent.transcriber || {};
  const inner = agent.Agent || agent.agent || {};
  return [
    `  mode         ${agent.Mode || agent.mode || 'unknown'}`,
    `  transcriber  ${transcriber.provider || '-'} ${transcriber.model || ''}`.trimEnd(),
    `  model        ${model.provider || '-'} ${model.model || ''}`.trimEnd(),
    `  voice        ${voice.provider || '-'} ${voice.voice_id || ''}`.trimEnd(),
    `  responds as  ${inner.response_type || inner.response_modality || '-'}`
  ].join('\n');
}
