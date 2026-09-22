// One function per subcommand. Each returns nothing and prints its own output.

import { readFile } from 'node:fs/promises';
import { createAgent, deleteAgent, getAgent, listAgents, readAgentId, updateAgent } from './api.js';
import { applySet, mergeDeep } from './cli.js';
import { loadPreset, PRESET_NAMES } from './presets.js';

export async function commandList(apiKey, { json }) {
  const agents = await listAgents(apiKey);
  if (json) {
    console.log(JSON.stringify(agents, null, 2));
    return;
  }
  if (!agents.length) {
    console.log('No saved agent configs. Create one with: node index.js create --preset pipeline');
    return;
  }
  console.log(`${agents.length} agent config${agents.length === 1 ? '' : 's'}\n`);
  for (const agent of agents) {
    const view = normalize(agent);
    console.log(`  ${view.id || '(no id)'}`);
    console.log(`    name    ${view.name || '-'}`);
    console.log(`    mode    ${view.mode || '-'}`);
    console.log(`    model   ${view.modelProvider || '-'} ${view.model || ''}`.trimEnd());
    console.log(`    replies ${view.responseType || '-'}${view.wakeWordSummary ? `, gated by ${view.wakeWordSummary}` : ''}`);
    console.log('');
  }
}

export async function commandGet(apiKey, agentConfigId, { json }) {
  requireId(agentConfigId, 'get');
  const agent = await getAgent(apiKey, agentConfigId);
  if (json) {
    console.log(JSON.stringify(agent, null, 2));
    return;
  }
  printAgent(agent);
}

export async function commandCreate(apiKey, { flags, sets, json }) {
  const body = await buildBody({ flags, sets, allowPreset: true });
  if (!Object.keys(body).length) {
    throw new Error(
      `Nothing to create. Start from a preset (--preset ${PRESET_NAMES.join('|')}) or supply --file <path.json>.`
    );
  }
  if (!body.mode) throw new Error('The request body needs a "mode" of "pipeline" or "realtime".');

  if (flags.dryRun) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  const created = await createAgent(apiKey, body);
  if (json) {
    console.log(JSON.stringify(created.raw, null, 2));
    return;
  }
  console.log(`[ok] Created agent ${created.agentConfigId}`);
  console.log(`     Attach it to a bot by passing agent_config_id: "${created.agentConfigId}" on create_bot.`);
}

export async function commandUpdate(apiKey, agentConfigId, { flags, sets, json }) {
  requireId(agentConfigId, 'update');
  const changes = await buildBody({ flags, sets, allowPreset: false });
  if (!Object.keys(changes).length) {
    throw new Error('Nothing to update. Pass --file, --name, --model, --prompt, or --set path=value.');
  }
  // PUT is a partial update: blocks you do not name are left untouched.
  delete changes.agent_config_id;

  if (flags.dryRun) {
    console.log(JSON.stringify({ agent_config_id: agentConfigId, ...changes }, null, 2));
    return;
  }

  const updated = await updateAgent(apiKey, agentConfigId, changes);
  if (json) {
    console.log(JSON.stringify(updated, null, 2));
    return;
  }
  console.log(`[ok] Updated agent ${agentConfigId}`);
  printAgent(updated);
}

export async function commandDelete(apiKey, agentConfigId, { flags, json }) {
  requireId(agentConfigId, 'delete');
  if (!flags.yes) {
    throw new Error(`Deleting an agent config cannot be undone. Re-run with --yes to confirm:\n  node index.js delete ${agentConfigId} --yes`);
  }
  const result = await deleteAgent(apiKey, agentConfigId);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`[ok] Deleted agent ${agentConfigId}`);
  console.log('     Bots already running with this config keep their attached agent until they leave.');
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function buildBody({ flags, sets, allowPreset }) {
  let body = {};

  if (flags.preset) {
    if (!allowPreset) throw new Error('--preset only applies to "create". Use --file or --set for updates.');
    body = loadPreset(flags.preset);
  }

  if (flags.file) {
    let text;
    try {
      text = await readFile(flags.file, 'utf8');
    } catch (cause) {
      throw new Error(`Could not read ${flags.file}: ${cause.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new Error(`${flags.file} is not valid JSON: ${cause.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${flags.file} must contain a JSON object.`);
    }
    body = mergeDeep(body, parsed);
  }

  if (flags.name) body.agent_name = flags.name;
  if (flags.model) body.model = { ...(body.model || {}), model: flags.model };
  if (flags.prompt) body.model = { ...(body.model || {}), system_prompt: flags.prompt };
  for (const assignment of sets) applySet(body, assignment);

  return body;
}

function requireId(agentConfigId, command) {
  if (!agentConfigId) {
    throw new Error(`"${command}" needs an agent_config_id.\n  node index.js ${command} <agent_config_id>`);
  }
}

/** The GET routes return PascalCase keys. Read both casings so either shape works. */
function normalize(agent = {}) {
  const model = agent.Model || agent.model || {};
  const voice = agent.Voice || agent.voice || {};
  const transcriber = agent.Transcriber || agent.transcriber || {};
  const inner = agent.Agent || agent.agent || {};
  const wakeWord = agent.WakeWord || agent.wake_word || {};
  const words = wakeWord.words || [];
  return {
    id: readAgentId(agent),
    name: agent.AgentName || agent.agent_name || '',
    mode: agent.Mode || agent.mode || '',
    modelProvider: model.provider || '',
    model: model.model || '',
    modelVoice: model.voice || '',
    systemPrompt: model.system_prompt || '',
    voiceProvider: voice.provider || '',
    voiceId: voice.voice_id || '',
    transcriberProvider: transcriber.provider || '',
    transcriberModel: transcriber.model || '',
    transcriberLanguage: transcriber.language || '',
    responseType: inner.response_type || inner.response_modality || '',
    firstMessage: inner.first_message || '',
    wakeWordSummary: wakeWord.enabled && words.length ? `"${words[0]}" (+${words.length - 1} more, ${wakeWord.timeout ?? '?'}s)` : ''
  };
}

function printAgent(agent) {
  const view = normalize(agent);
  console.log(`  agent_config_id  ${view.id || '(not returned)'}`);
  console.log(`  agent_name       ${view.name || '-'}`);
  console.log(`  mode             ${view.mode || '-'}`);
  console.log(`  model            ${view.modelProvider || '-'} ${view.model || ''}`.trimEnd());
  if (view.mode === 'realtime') {
    console.log(`  voice            ${view.modelVoice || '-'} (inside the realtime model)`);
  } else {
    console.log(`  transcriber      ${view.transcriberProvider || '-'} ${view.transcriberModel || ''} ${view.transcriberLanguage || ''}`.trimEnd());
    console.log(`  voice            ${view.voiceProvider || '-'} ${view.voiceId || ''}`.trimEnd());
  }
  console.log(`  response_type    ${view.responseType || '-'}`);
  if (view.firstMessage) console.log(`  first_message    ${view.firstMessage}`);
  console.log(`  wake_word        ${view.wakeWordSummary || 'disabled'}`);
  if (view.systemPrompt) console.log(`  system_prompt    ${truncate(view.systemPrompt, 200)}`);
}

function truncate(text, limit) {
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}
