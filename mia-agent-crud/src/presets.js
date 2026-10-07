// Starting points for `create --preset <name>`.
//
// These are ordinary request bodies for POST /mia. Override any field with
// --name / --model / --prompt / --set, or replace the whole body with --file.
//
// Pipeline mode chains three swappable layers:
//   transcriber (speech to text) -> model (text to text) -> voice (text to speech)
// Realtime mode replaces all three with one speech-to-speech model, so it has no
// separate voice, transcriber, or wake_word block.

export const PRESETS = {
  pipeline: {
    agent_name: 'Pipeline Voice Assistant',
    mode: 'pipeline',
    model: {
      provider: 'openai',
      model: 'gpt-4.1',
      system_prompt:
        'You are a spoken assistant in a live meeting. Answer in one or two short sentences. Never guess.'
    },
    voice: { provider: 'openai', voice_id: 'nova' },
    transcriber: { provider: 'deepgram', model: 'nova-3', language: 'en' },
    agent: {
      response_type: 'voice',
      first_message: 'Hi, I am here if you need anything.',
      mcp_servers: []
    }
  },

  realtime: {
    agent_name: 'Realtime Voice Assistant',
    mode: 'realtime',
    model: {
      provider: 'openai',
      model: 'gpt-4o-realtime-preview',
      voice: 'nova',
      system_prompt:
        'You are a spoken assistant in a live meeting. Answer in one or two short sentences. Never guess.'
    },
    agent: {
      response_type: 'voice',
      first_message: 'Hi, I am listening.',
      mcp_servers: []
    }
  },

  'wake-word': {
    agent_name: 'Wake Word Meeting Assistant',
    mode: 'pipeline',
    model: {
      provider: 'openai',
      model: 'gpt-4.1-mini',
      system_prompt:
        'You are a meeting assistant. You are only woken when someone addresses you, so answer every ' +
        'request you receive. Keep answers to one or two spoken sentences. Never guess.'
    },
    voice: { provider: 'openai', voice_id: 'nova' },
    transcriber: {
      provider: 'deepgram',
      model: 'nova-3',
      language: 'en',
      boostwords: ['hey acme', 'ok acme', 'okay acme']
    },
    agent: {
      response_type: 'voice',
      first_message: 'Say "hey acme" followed by your question.',
      mcp_servers: []
    },
    // wake_word is a pipeline-mode block. Realtime configs do not have one.
    wake_word: { enabled: true, words: ['hey acme', 'ok acme', 'okay acme'], timeout: 30 }
  }
};

export const PRESET_NAMES = Object.keys(PRESETS);

export function loadPreset(name) {
  const preset = PRESETS[name];
  if (!preset) throw new Error(`Unknown preset "${name}". Available: ${PRESET_NAMES.join(', ')}.`);
  return structuredClone(preset);
}
