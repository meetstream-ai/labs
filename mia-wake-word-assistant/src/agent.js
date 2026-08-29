// Builds a wake-word-gated pipeline MIA config.
//
// A meeting assistant that answers every sentence it hears is unusable: it talks
// over people, reacts to side conversations, and burns model spend on audio that
// was never meant for it. The `wake_word` block moves that gate into MeetStream,
// so the model is only invoked once someone actually addresses the agent.
//
// wake_word is a pipeline-mode block. Realtime agents do not have one.

import { optional, optionalNumber } from './env.js';

const DEFAULT_WAKE_WORDS = ['hey acme', 'ok acme', 'okay acme'];

const DEFAULT_SYSTEM_PROMPT =
  'You are the Acme meeting assistant. MeetStream only wakes you when someone addresses you directly, ' +
  'so treat every request you receive as meant for you and answer it. Keep answers to one or two spoken ' +
  'sentences. If the request is ambiguous, ask one short clarifying question. Never guess.';

const DEFAULT_FIRST_MESSAGE = 'Acme assistant here. Say "hey acme" followed by your question.';

/** Parses MIA_WAKE_WORDS: a comma separated list, lowercased and de-duplicated. */
export function parseWakeWords(value) {
  const words = String(value || '')
    .split(',')
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(words)];
}

/**
 * Transcription rarely returns a wake phrase exactly as written. "hey acme" comes
 * back as "hey akme", "hey, acme" or "hey acne". Feeding the phrase list to the
 * transcriber as boostwords biases recognition toward the spellings the gate
 * matches on, which is the single biggest fix for a gate that never fires.
 */
export function buildWakeWordAgentConfig() {
  const words = parseWakeWords(optional('MIA_WAKE_WORDS', DEFAULT_WAKE_WORDS.join(', ')));
  if (!words.length) {
    throw new Error('MIA_WAKE_WORDS must contain at least one phrase, for example: hey acme, ok acme');
  }

  const timeout = optionalNumber('MIA_WAKE_WORD_TIMEOUT_SECONDS', 30);
  const responseType = optional('MIA_RESPONSE_TYPE', 'voice');
  if (!['voice', 'chat', 'action'].includes(responseType)) {
    throw new Error('MIA_RESPONSE_TYPE must be voice, chat, or action.');
  }

  return {
    agent_name: optional('MIA_AGENT_NAME', 'Wake Word Meeting Assistant'),
    mode: 'pipeline',
    model: {
      provider: optional('MIA_MODEL_PROVIDER', 'openai'),
      model: optional('MIA_MODEL', 'gpt-4.1-mini'),
      system_prompt: optional('MIA_SYSTEM_PROMPT', DEFAULT_SYSTEM_PROMPT)
    },
    voice: {
      provider: optional('MIA_VOICE_PROVIDER', 'openai'),
      voice_id: optional('MIA_VOICE_ID', 'nova')
    },
    transcriber: {
      provider: optional('MIA_TRANSCRIBER_PROVIDER', 'deepgram'),
      model: optional('MIA_TRANSCRIBER_MODEL', 'nova-3'),
      language: optional('MIA_TRANSCRIBER_LANGUAGE', 'en'),
      boostwords: words
    },
    agent: {
      response_type: responseType,
      first_message: optional('MIA_FIRST_MESSAGE', DEFAULT_FIRST_MESSAGE),
      mcp_servers: []
    },
    wake_word: {
      enabled: true,
      words,
      timeout
    }
  };
}

/** Reads back a saved config for display. The GET route returns PascalCase keys. */
export function describeAgent(agent = {}) {
  const model = agent.Model || agent.model || {};
  const voice = agent.Voice || agent.voice || {};
  const transcriber = agent.Transcriber || agent.transcriber || {};
  const inner = agent.Agent || agent.agent || {};
  const wakeWord = agent.WakeWord || agent.wake_word || {};
  return [
    `  mode         ${agent.Mode || agent.mode || 'unknown'}`,
    `  transcriber  ${transcriber.provider || '-'} ${transcriber.model || ''}`.trimEnd(),
    `  model        ${model.provider || '-'} ${model.model || ''}`.trimEnd(),
    `  voice        ${voice.provider || '-'} ${voice.voice_id || ''}`.trimEnd(),
    `  responds as  ${inner.response_type || inner.response_modality || '-'}`,
    `  wake word    ${wakeWord.enabled ? `${(wakeWord.words || []).join(' | ')} (window ${wakeWord.timeout ?? '?'}s)` : 'disabled'}`
  ].join('\n');
}

/** Warns loudly if a reused config has no gate, since that changes cost and behaviour. */
export function assertGateEnabled(agent = {}) {
  const mode = agent.Mode || agent.mode;
  if (mode && mode !== 'pipeline') {
    throw new Error(
      `MEETSTREAM_AGENT_CONFIG_ID points at a "${mode}" agent. Wake-word gating is a pipeline-mode feature.`
    );
  }
  const wakeWord = agent.WakeWord || agent.wake_word || {};
  if (!wakeWord.enabled) {
    console.warn('[!!] The saved agent has wake_word disabled, so it will respond to everything it hears.');
  } else if (!(wakeWord.words || []).length) {
    throw new Error('The saved agent has wake_word enabled but no phrases, so it can never be activated.');
  }
}
