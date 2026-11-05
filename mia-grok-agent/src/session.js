// The join and shutdown flow: save or reuse the Grok agent, send a bot into the
// meeting, follow its status, and remove it (and optionally the agent) on stop.
//
// index.js wires this to the environment and to Ctrl+C. Keeping the flow here
// lets the tests drive it against a mock MeetStream server.

import { randomUUID } from 'node:crypto';
import { assertGrokAgent, buildGrokAgentConfig, describeAgent, voiceWarning } from './agent.js';
import { createAgent, createBot, deleteAgent, getAgent, removeBot, watchBot } from './api.js';

export function botPayload(config, agentConfigId) {
  // The only MIA field on create_bot is agent_config_id. No socket_connection_url,
  // no live_audio_required: those are for bring-your-own-bridge setups.
  const payload = {
    meeting_link: config.meetingLink,
    bot_name: config.botName,
    // Audio only. `false` is sent explicitly because the REST API treats an
    // omitted `video_required` as true. Record the demo with your own screen
    // recorder; the bot's recording is the backup and the transcript source.
    video_required: false,
    agent_config_id: agentConfigId
  };
  if (config.callbackUrl) payload.callback_url = config.callbackUrl;
  // Ask for a post-call transcript, so `--verify` can check the recording afterwards.
  if (config.transcribe) {
    payload.recording_config = {
      transcript: { provider: { deepgram: { model: 'nova-3', language: 'en', smart_format: true, punctuate: true } } }
    };
  }
  return payload;
}

export function warnAboutVoice(agentConfig, warn = console.warn) {
  const warning = voiceWarning(agentConfig);
  if (warning) warn(`[??] ${warning} MeetStream may reject it with HTTP 400.`);
}

/**
 * config: { apiKey, meetingLink, existingAgentConfigId, botName, callbackUrl,
 *           deleteAgentOnExit, pollIntervalMs }
 * io:     { log, warn, error } - injected so tests can capture output.
 *
 * run() resolves when the bot reaches a terminal status, when stop() is called,
 * or when startup fails. stop() resolves once the bot (and agent, if asked) are removed.
 * `failed` turns true if startup or a cleanup call failed, for the exit code.
 */
export function createSession(config, io = {}) {
  const log = io.log ?? console.log;
  const warn = io.warn ?? console.warn;
  const error = io.error ?? console.error;
  const startedAt = Date.now();

  const state = { botId: null, agentConfigId: null, failed: false };
  let stopping = null;
  let startup = null;

  /** Elapsed time since start, so log lines can be matched against the screen recording. */
  const stamp = () => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  };

  async function join() {
    if (config.existingAgentConfigId) {
      const agent = await getAgent(config.apiKey, config.existingAgentConfigId);
      assertGrokAgent(agent);
      state.agentConfigId = config.existingAgentConfigId;
      log(`[${stamp()}] Reusing saved Grok agent ${state.agentConfigId}`);
      log(describeAgent(agent));
    } else {
      const agentConfig = buildGrokAgentConfig();
      warnAboutVoice(agentConfig, warn);
      const created = await createAgent(config.apiKey, agentConfig);
      state.agentConfigId = created.agentConfigId;
      log(`[${stamp()}] Created Grok agent ${state.agentConfigId}`);
      log(describeAgent(agentConfig));
      if (!config.deleteAgentOnExit) {
        log('        Reuse it next run with MEETSTREAM_AGENT_CONFIG_ID=' + state.agentConfigId);
      }
    }

    if (stopping) return;

    const bot = await createBot(config.apiKey, botPayload(config, state.agentConfigId), randomUUID());
    state.botId = bot.bot_id;
    log(`[${stamp()}] Bot ${bot.bot_id} is joining ${bot.meeting_url || config.meetingLink}`);
    if (bot.transcript_id) log(`        transcript_id ${bot.transcript_id}`);
    log('        Admit it from the waiting room, then talk to Grok. Ctrl+C to remove it.');

    const finalStatus = await watchBot(config.apiKey, state.botId, {
      intervalMs: config.pollIntervalMs,
      shouldStop: () => Boolean(stopping),
      onStatus: (status) => log(`[${stamp()}] status: ${status}`)
    });
    if (finalStatus && !stopping) log(`[${stamp()}] Session finished with status ${finalStatus}`);
  }

  async function cleanup() {
    if (state.botId) {
      try {
        await removeBot(config.apiKey, state.botId);
        log(`[${stamp()}] Asked MeetStream to remove the bot`);
      } catch (err) {
        state.failed = true;
        error(`[!!] Could not remove bot ${state.botId}: ${err.message}`);
      }
      state.botId = null;
    }
    if (config.deleteAgentOnExit && state.agentConfigId) {
      try {
        await deleteAgent(config.apiKey, state.agentConfigId);
        log(`[${stamp()}] Deleted agent ${state.agentConfigId}`);
      } catch (err) {
        state.failed = true;
        error(`[!!] Could not delete agent ${state.agentConfigId}: ${err.message}`);
      }
      state.agentConfigId = null;
    }
  }

  function run() {
    startup = join().catch(async (err) => {
      error(`[!!] ${err.message}`);
      state.failed = true;
      if (!stopping) await cleanup();
    });
    return startup;
  }

  function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      log('\nStopping...');
      await startup?.catch(() => {});
      await cleanup();
    })();
    return stopping;
  }

  return { run, stop, state };
}
