// MeetStream Labs: pipeline-mode MIA voice agent.
//
// 1. Save a pipeline MIA config (STT -> LLM -> TTS) with POST /mia.
// 2. Send a bot into a meeting with that config attached.
// 3. Follow the bot status until you press Ctrl+C, then clean up.
//
// Attaching a MIA agent needs exactly one field on create_bot: agent_config_id.
// MeetStream hosts the agent bridge itself, so this template never opens a websocket.

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { buildPipelineAgentConfig, describeAgent } from './src/agent.js';
import { createAgent, createBot, deleteAgent, getAgent, removeBot, watchBot } from './src/api.js';
import { optional, optionalBoolean, optionalHttpsUrl, optionalNumber, required, requireHttpsUrl } from './src/env.js';

let state = { apiKey: null, botId: null, agentConfigId: null, deleteAgentOnExit: false };
let stopping = null;
let startup = null;

function loadConfig() {
  return {
    apiKey: required('MEETSTREAM_API_KEY', 'Create one at https://app.meetstream.ai.'),
    meetingLink: requireHttpsUrl('MEETING_LINK', 'Paste the Google Meet, Zoom, or Teams link.'),
    existingAgentConfigId: optional('MEETSTREAM_AGENT_CONFIG_ID'),
    botName: optional('BOT_NAME', 'MIA Voice Agent'),
    callbackUrl: optionalHttpsUrl('CALLBACK_URL'),
    deleteAgentOnExit: optionalBoolean('DELETE_AGENT_ON_EXIT', false),
    pollIntervalMs: optionalNumber('POLL_INTERVAL_SECONDS', 10) * 1000
  };
}

async function main() {
  const config = loadConfig();
  state.apiKey = config.apiKey;
  state.deleteAgentOnExit = config.deleteAgentOnExit;

  if (config.existingAgentConfigId) {
    const agent = await getAgent(config.apiKey, config.existingAgentConfigId);
    state.agentConfigId = config.existingAgentConfigId;
    console.log(`[ok] Reusing saved agent ${state.agentConfigId}`);
    console.log(describeAgent(agent));
  } else {
    const agentConfig = buildPipelineAgentConfig();
    const created = await createAgent(config.apiKey, agentConfig);
    state.agentConfigId = created.agentConfigId;
    console.log(`[ok] Created pipeline agent ${state.agentConfigId}`);
    console.log(describeAgent(agentConfig));
    if (!config.deleteAgentOnExit) {
      console.log('     Reuse it next run with MEETSTREAM_AGENT_CONFIG_ID=' + state.agentConfigId);
    }
  }

  if (stopping) return;

  // The only MIA field on create_bot. No socket_connection_url, no live_audio_required.
  const payload = {
    meeting_link: config.meetingLink,
    bot_name: config.botName,
    video_required: false,
    agent_config_id: state.agentConfigId
  };
  if (config.callbackUrl) payload.callback_url = config.callbackUrl;

  const bot = await createBot(config.apiKey, payload, randomUUID());
  state.botId = bot.bot_id;
  console.log(`[ok] Bot ${bot.bot_id} is joining ${bot.meeting_url || config.meetingLink}`);
  if (bot.transcript_id) console.log(`     transcript_id ${bot.transcript_id}`);
  console.log('     Admit it from the waiting room, then talk to it. Ctrl+C to stop.');

  const finalStatus = await watchBot(config.apiKey, state.botId, {
    intervalMs: config.pollIntervalMs,
    shouldStop: () => Boolean(stopping),
    onStatus: (status) => console.log(`     status: ${status}`)
  });
  if (finalStatus && !stopping) console.log(`[ok] Session finished with status ${finalStatus}`);
}

async function cleanup() {
  if (state.botId) {
    try {
      await removeBot(state.apiKey, state.botId);
      console.log('[ok] Asked MeetStream to remove the bot');
    } catch (error) {
      process.exitCode = 1;
      console.error(`[!!] Could not remove bot ${state.botId}: ${error.message}`);
    }
    state.botId = null;
  }
  if (state.deleteAgentOnExit && state.agentConfigId) {
    try {
      await deleteAgent(state.apiKey, state.agentConfigId);
      console.log(`[ok] Deleted agent ${state.agentConfigId}`);
    } catch (error) {
      process.exitCode = 1;
      console.error(`[!!] Could not delete agent ${state.agentConfigId}: ${error.message}`);
    }
    state.agentConfigId = null;
  }
}

function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    console.log('\nStopping...');
    await startup?.catch(() => {});
    await cleanup();
  })();
  return stopping;
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

startup = main().catch(async (error) => {
  console.error(`[!!] ${error.message}`);
  process.exitCode = 1;
  if (!stopping) await cleanup();
});
