import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertGrokAgent, buildGrokAgentConfig, describeAgent, selectedScript, voiceWarning } from '../src/agent.js';
import { SCRIPTS } from '../src/scripts.js';

const VARS = ['GROK_SCRIPT', 'GROK_VOICE', 'GROK_MODEL', 'GROK_FIRST_MESSAGE', 'GROK_SYSTEM_PROMPT', 'GROK_ALLOW_INTERRUPTIONS', 'MIA_AGENT_NAME'];

afterEach(() => {
  for (const name of VARS) delete process.env[name];
});

test('default config is a realtime xAI agent that answers in audio', () => {
  const config = buildGrokAgentConfig();
  assert.equal(config.mode, 'realtime');
  assert.equal(config.model.provider, 'xai');
  assert.equal(config.model.voice, 'Ara');
  assert.equal(config.agent.response_modality, 'audio');
  assert.equal(config.agent.vad_type, 'semantic_vad');
  assert.equal(config.agent.enable_interruptions, true);
  assert.deepEqual(config.audio, { sample_rate: 24000, num_channels: 1 });
  assert.equal(config.model.first_message, '');
  assert.ok(config.model.system_prompt);
});

test('realtime config carries no pipeline blocks', () => {
  const config = buildGrokAgentConfig();
  assert.equal(config.voice, undefined);
  assert.equal(config.transcriber, undefined);
  assert.equal(config.wake_word, undefined);
});

test('model id is sent only when set', () => {
  assert.equal('model' in buildGrokAgentConfig().model, false);
  process.env.GROK_MODEL = 'grok-voice-test';
  assert.equal(buildGrokAgentConfig().model.model, 'grok-voice-test');
});

test('env overrides reach the body', () => {
  process.env.GROK_VOICE = 'Rex';
  process.env.GROK_FIRST_MESSAGE = 'Hello.';
  process.env.GROK_ALLOW_INTERRUPTIONS = 'false';
  const config = buildGrokAgentConfig();
  assert.equal(config.model.voice, 'Rex');
  assert.equal(config.model.first_message, 'Hello.');
  assert.equal(config.agent.enable_interruptions, false);
});

test('voice warnings', () => {
  assert.equal(voiceWarning({ model: { voice: 'Ara' } }), null, "MeetStream's spelling");
  assert.equal(voiceWarning({ model: { voice: 'ara' } }), null, "xAI's spelling");
  assert.equal(voiceWarning({ model: { voice: 'Rigel' } }), null, 'one of the newer voices');
  assert.match(voiceWarning({ model: { voice: 'nova' } }), /not one of the 28 built-in Grok voices/);
});

test('assertGrokAgent accepts a saved Grok agent in either casing', () => {
  assert.doesNotThrow(() => assertGrokAgent({ Mode: 'realtime', Model: { provider: 'xai' } }));
  assert.doesNotThrow(() => assertGrokAgent({ mode: 'realtime', model: { provider: 'xai' } }));
});

test('assertGrokAgent rejects pipeline and non-xAI agents', () => {
  assert.throws(() => assertGrokAgent({ Mode: 'pipeline', Model: { provider: 'openai' } }), /"pipeline" agent/);
  assert.throws(() => assertGrokAgent({ Mode: 'realtime', Model: { provider: 'openai' } }), /not Grok/);
});

test('describeAgent reads the PascalCase GET shape', () => {
  const text = describeAgent({ Mode: 'realtime', Model: { provider: 'xai', voice: 'Ara' }, Agent: { enable_interruptions: 0, response_modality: 'audio' } });
  assert.match(text, /realtime/);
  assert.match(text, /xai \(MeetStream default\)/);
  assert.match(text, /interruptions\s+off/);
  assert.match(text, /responds as\s+audio/);
});

test('GROK_SCRIPT=launch-demo uses the scripted prompt of the recorded agent', () => {
  process.env.GROK_SCRIPT = 'launch-demo';
  const config = buildGrokAgentConfig();
  assert.equal(config.model.system_prompt, SCRIPTS['launch-demo'].prompt);
  assert.match(config.model.system_prompt, /Yes, I can hear you\. I'm ready to participate in the meeting/);
  assert.equal(selectedScript().name, 'launch-demo');
  assert.deepEqual(selectedScript().expect, ['i can hear you', 'ready to participate in the meeting']);
});

test('an explicit GROK_SYSTEM_PROMPT beats the script, and no script means the plain prompt', () => {
  process.env.GROK_SCRIPT = 'launch-demo';
  process.env.GROK_SYSTEM_PROMPT = 'Be brief.';
  assert.equal(buildGrokAgentConfig().model.system_prompt, 'Be brief.');
  delete process.env.GROK_SCRIPT;
  delete process.env.GROK_SYSTEM_PROMPT;
  assert.equal(selectedScript(), null);
  assert.doesNotMatch(buildGrokAgentConfig().model.system_prompt, /filmed for a short product demo/);
});

test('an unknown GROK_SCRIPT fails loudly and lists the real ones', () => {
  process.env.GROK_SCRIPT = 'nope';
  assert.throws(() => buildGrokAgentConfig(), /"nope" is not a known script\. Available: launch-demo/);
});
