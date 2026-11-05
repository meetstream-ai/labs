// Builds the realtime-mode MIA config for Grok that gets POSTed to /mia.
//
// Grok runs as a MeetStream realtime agent: one speech-to-speech model hears the
// room and speaks back, so there is no `voice`, `transcriber`, or `wake_word`
// block. The shape follows the "Realtime - xAI Grok" example in the MeetStream
// API reference (POST /mia), with the `agent` settings taken from the saved
// agent that recorded the first real Grok call (2026-09-30): audio responses,
// semantic VAD, preemptive generation, and no greeting.

import { optional, optionalBoolean } from './env.js';
import { SCRIPTS, SCRIPT_NAMES } from './scripts.js';

// Built-in Grok voices from xAI's voice docs (docs.x.ai, October 2026). xAI lists
// them in lowercase and MeetStream's example uses "Ara", so names match in any case.
// xAI adds voices and supports custom voice ids, so an unknown name is a warning,
// not an error.
export const GROK_VOICES = [
  'ara', 'eve', 'leo', 'rex', 'sal',
  'altair', 'atlas', 'aurora', 'carina', 'castor', 'celeste', 'cosmo', 'helios', 'helix',
  'iris', 'kepler', 'liora', 'lumen', 'luna', 'lux', 'naksh', 'orion', 'perseus', 'rigel',
  'sirius', 'ursa', 'zagan', 'zenith'
];

const DEFAULT_SYSTEM_PROMPT =
  'You are Grok, built by xAI, taking part in a live video meeting as a participant through MeetStream. ' +
  'You hear everyone in the call and you answer out loud. Keep every reply to one or two short spoken ' +
  'sentences so it lands before the conversation moves on. Never read out markdown, lists, or code. ' +
  'Only speak when someone talks to you. If you are not sure, say so rather than guessing.';

/** The preset picked by GROK_SCRIPT (or --demo), or null. An unknown name fails loudly. */
export function selectedScript() {
  const name = optional('GROK_SCRIPT');
  if (!name) return null;
  if (!SCRIPTS[name]) throw new Error(`GROK_SCRIPT "${name}" is not a known script. Available: ${SCRIPT_NAMES.join(', ')}.`);
  return { name, ...SCRIPTS[name] };
}

export function buildGrokAgentConfig() {
  const voice = optional('GROK_VOICE', 'Ara');
  const model = optional('GROK_MODEL');
  const script = selectedScript();

  const modelBlock = {
    provider: 'xai',
    voice,
    system_prompt: optional('GROK_SYSTEM_PROMPT', script ? script.prompt : DEFAULT_SYSTEM_PROMPT),
    // Empty by default: Grok waits to be addressed instead of greeting the room
    // the moment it is admitted, which keeps the opening of a take clean.
    first_message: optional('GROK_FIRST_MESSAGE', ''),
    temperature: 0.8
  };
  // MeetStream picks its default Grok voice model when this is left out.
  if (model) modelBlock.model = model;

  return {
    agent_name: optional('MIA_AGENT_NAME', 'Grok Meeting Demo'),
    mode: 'realtime',
    model: modelBlock,
    agent: {
      response_modality: 'audio',
      custom_functions: [],
      mcp_servers: [],
      preemptive_generation: true,
      user_away_timeout: 15,
      // Semantic VAD decides when a speaker has finished a thought, not just
      // when they paused, so Grok does not jump in mid-sentence.
      interruption_mode: 'vad',
      vad_type: 'semantic_vad',
      vad_eagerness: 'medium',
      vad_create_response: true,
      vad_interrupt_response: true,
      // With interruptions on, talking over Grok stops it mid-sentence. Turn
      // them off for a recording in a noisy room so a cough cannot cut a take.
      enable_interruptions: optionalBoolean('GROK_ALLOW_INTERRUPTIONS', true),
      interruptions: { min_duration_seconds: 0.5, word_threshold: 0 },
      false_interruption_timeout: 2,
      resume_false_interruption: true
    },
    audio: { sample_rate: 24000, num_channels: 1 }
  };
}

/** Voice names that would likely be rejected, so they show up before the call, not during it. */
export function voiceWarning(config) {
  const voice = config.model?.voice;
  if (!voice || GROK_VOICES.includes(voice.toLowerCase())) return null;
  return `GROK_VOICE "${voice}" is not one of the ${GROK_VOICES.length} built-in Grok voices (${GROK_VOICES.join(', ')}). If it isn't a custom xAI voice id,`;
}

/** Reads back a saved config for display. The GET route returns PascalCase keys. */
export function describeAgent(agent = {}) {
  const model = agent.Model || agent.model || {};
  const inner = agent.Agent || agent.agent || {};
  return [
    `  mode           ${agent.Mode || agent.mode || 'unknown'}`,
    `  model          ${model.provider || '-'} ${model.model || '(MeetStream default)'}`,
    `  voice          ${model.voice || '-'}`,
    // The GET route returns booleans as 0/1.
    `  interruptions  ${inner.enable_interruptions === false || inner.enable_interruptions === 0 ? 'off' : 'on'}`,
    `  responds as    ${inner.response_type || inner.response_modality || '-'}`
  ].join('\n');
}

/** Guard against reusing an agent that is not a realtime Grok agent. */
export function assertGrokAgent(agent = {}) {
  const mode = agent.Mode || agent.mode;
  const provider = (agent.Model || agent.model || {}).provider;
  if (mode && mode !== 'realtime') {
    throw new Error(
      `MEETSTREAM_AGENT_CONFIG_ID points at a "${mode}" agent. This demo expects a realtime Grok agent. ` +
        'Unset the id to create one.'
    );
  }
  if (provider && provider !== 'xai') {
    throw new Error(
      `MEETSTREAM_AGENT_CONFIG_ID points at a "${provider}" agent, not Grok. Unset the id to create a Grok agent.`
    );
  }
}
