// Grok in a live meeting, through MeetStream MIA.
//
// Built on the mia-realtime-agent template from https://github.com/meetstream-ai/labs.
//
// 1. Save a realtime MIA config with Grok (provider "xai") as the model, via POST /mia.
// 2. Send a bot into the meeting with that config attached.
// 3. Follow the bot status until you press Ctrl+C, then remove the bot.
//
// MeetStream hosts the audio bridge and the connection to xAI, so this program
// opens no websocket and never sees an xAI key.
//
//   node index.js              join the meeting
//   node index.js --dry-run    print the agent config and bot request, send nothing
//   node index.js --check      also verify the API key and any saved agent, no bot


import 'dotenv/config';
import { assertGrokAgent, buildGrokAgentConfig, describeAgent, selectedScript } from './src/agent.js';
import { getAgent, listAgents } from './src/api.js';
import { optional, optionalBoolean, optionalHttpsUrl, optionalNumber, required, requireHttpsUrl } from './src/env.js';
import { botPayload, createSession, warnAboutVoice } from './src/session.js';
import { verifyBot } from './src/verify.js';

const argv = process.argv.slice(2);
const args = new Set(argv);
// --demo selects the scripted launch-demo prompt, the one the first real call was recorded with.
if (args.has('--demo')) process.env.GROK_SCRIPT ||= 'launch-demo';

/** Every value after a repeated flag: --expect "a" --expect "b". */
const flagValues = (flag) => argv.flatMap((arg, i) => (arg === flag && argv[i + 1] ? [argv[i + 1]] : []));

function loadConfig({ needMeeting, needKey = true }) {
  return {
    apiKey: needKey
      ? required('MEETSTREAM_API_KEY', 'Create one at https://app.meetstream.ai.')
      : optional('MEETSTREAM_API_KEY'),
    meetingLink: needMeeting
      ? requireHttpsUrl('MEETING_LINK', 'Paste the Google Meet, Zoom, or Teams link.')
      : optional('MEETING_LINK'),
    existingAgentConfigId: optional('MEETSTREAM_AGENT_CONFIG_ID'),
    botName: optional('BOT_NAME', 'Grok'),
    callbackUrl: optionalHttpsUrl('CALLBACK_URL'),
    deleteAgentOnExit: optionalBoolean('DELETE_AGENT_ON_EXIT', false),
    transcribe: optionalBoolean('TRANSCRIBE', false),
    pollIntervalMs: optionalNumber('POLL_INTERVAL_SECONDS', 5) * 1000
  };
}

function printHelp() {
  console.log('Usage: node index.js [--demo] [--dry-run | --check | --verify <bot_id>]');
  console.log('  (no flag)   save a Grok agent (or reuse MEETSTREAM_AGENT_CONFIG_ID), send it into MEETING_LINK');
  console.log('  --demo      use the scripted launch-demo prompt (the one the first real call was recorded with)');
  console.log('  --dry-run   print the agent config and create_bot request; no network calls');
  console.log('  --check     verify the API key and the saved agent, if any; no bot is sent');
  console.log('  --verify <bot_id>   check the recording of a finished call: speech present, expected phrases heard');
  console.log('      --transcribe     create the transcript from the stored audio if the bot has none');
  console.log('      --expect "text"  a phrase that must be heard; repeatable (--demo adds the launch-demo phrases)');
  console.log('  Ctrl+C removes the bot. See README.md for every variable.');
}

async function dryRun() {
  const config = loadConfig({ needMeeting: false, needKey: false });
  const agentConfig = buildGrokAgentConfig();
  warnAboutVoice(agentConfig);
  console.log('POST /mia');
  console.log(JSON.stringify(agentConfig, null, 2));
  console.log('\nPOST /bots/create_bot');
  const payload = botPayload(config, config.existingAgentConfigId || '<agent_config_id from POST /mia>');
  console.log(JSON.stringify({ ...payload, meeting_link: payload.meeting_link || '<MEETING_LINK>' }, null, 2));
}

async function check() {
  const config = loadConfig({ needMeeting: false });
  const agents = await listAgents(config.apiKey);
  console.log(`[ok] MeetStream accepted the API key (${agents.length} saved agent config(s))`);

  if (config.existingAgentConfigId) {
    const agent = await getAgent(config.apiKey, config.existingAgentConfigId);
    assertGrokAgent(agent);
    console.log(`[ok] Saved agent ${config.existingAgentConfigId} is a realtime Grok agent`);
    console.log(describeAgent(agent));
  } else {
    const agentConfig = buildGrokAgentConfig();
    warnAboutVoice(agentConfig);
    console.log('[ok] No MEETSTREAM_AGENT_CONFIG_ID set; a run will create this agent:');
    console.log(describeAgent(agentConfig));
    console.log('     Save one ahead of the recording so a live run skips that step.');
  }

  if (config.meetingLink) {
    requireHttpsUrl('MEETING_LINK');
    console.log(`[ok] MEETING_LINK ${config.meetingLink}`);
  } else {
    console.log('[??] MEETING_LINK is not set yet. Add it before the run.');
  }
}

async function verify() {
  const botId = argv[argv.indexOf('--verify') + 1];
  if (!botId || botId.startsWith('--')) throw new Error('--verify needs a bot id: node index.js --verify <bot_id>');
  const config = loadConfig({ needMeeting: false });
  const expect = [...flagValues('--expect'), ...(selectedScript()?.expect ?? [])];

  const result = await verifyBot(config.apiKey, botId, { expect, transcribe: args.has('--transcribe') });
  console.log('');
  console.log(`Transcript ${result.transcriptId}`);
  for (const turn of result.turns) console.log(`  [${String(Math.round(turn.start ?? 0)).padStart(3)}s] ${turn.speaker}: ${turn.text}`);
  console.log('');
  console.log(`${result.words >= result.minWords ? '[ok]' : '[!!]'} ${result.words} words heard (need ${result.minWords})`);
  for (const phrase of result.found) console.log(`[ok] heard "${phrase}"`);
  for (const phrase of result.missing) console.log(`[!!] never heard "${phrase}"`);
  if (result.botTurns) console.log(`[ok] ${result.botTurns} line(s) labelled "${result.botName}", the bot's own name`);
  else console.log(`[??] No lines labelled "${result.botName || 'the bot'}"; the labels did not separate the bot from people in this call.`);
  if (!expect.length) console.log('[??] No --expect phrases given, so only the presence of speech was checked.');
  console.log('');
  console.log(result.ok ? 'PASS: the recording contains the call audio.' : 'FAIL');
  console.log('Note: this shows the words are in the recording. Listen to the audio for tone and timing.');
  if (!result.ok) process.exitCode = 1;
}

async function main() {
  if (args.has('--help') || args.has('-h')) return printHelp();
  if (args.has('--verify')) return verify();
  if (args.has('--dry-run')) return dryRun();
  if (args.has('--check')) return check();

  const session = createSession(loadConfig({ needMeeting: true }));
  const stop = () => session.stop().then(() => {
    if (session.state.failed) process.exitCode = 1;
  });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await session.run();
  if (session.state.failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[!!] ${error.message}`);
  process.exitCode = 1;
});
