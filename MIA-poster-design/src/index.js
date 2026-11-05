import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { createCanvaBridge } from './canvaBridge.js';
import { deployBot, fetchAgentConfig, removeBot, validateAgentConfig } from './deployBot.js';
import { createBotEventTracker, startNgrokTunnel, startWebhookServer } from './webhookServer.js';

dotenv.config({ override: true, quiet: true });

export function settings(env = process.env) {
  const callbackUrl = env.CALLBACK_URL?.trim();
  const required = ['MEETSTREAM_API_KEY', 'MEETSTREAM_AGENT_CONFIG_ID', 'MEETING_LINK', ...(!callbackUrl ? ['NGROK_AUTHTOKEN'] : [])];
  const missing = required.filter((name) => !env[name]?.trim() || /^your_.+_here$/i.test(env[name].trim()));
  if (missing.length) throw new Error(`Fill in ${missing.join(', ')} in .env.`);
  const meetingLink = new URL(env.MEETING_LINK);
  if (meetingLink.protocol !== 'https:') throw new Error('MEETING_LINK must start with https://.');
  if (callbackUrl && !callbackUrl.startsWith('https://')) throw new Error('CALLBACK_URL must start with https://.');
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a whole number from 1 to 65535.');
  const adapterOnly = (env.ADAPTER_ONLY || 'false').toLowerCase();
  if (!['true', 'false'].includes(adapterOnly)) throw new Error('ADAPTER_ONLY must be true or false.');
  return {
    apiKey: env.MEETSTREAM_API_KEY.trim(),
    agentConfigId: env.MEETSTREAM_AGENT_CONFIG_ID.trim(),
    meetingLink: meetingLink.href,
    callbackUrl,
    port,
    adapterOnly: adapterOnly === 'true'
  };
}

let server;
let tunnel;
let activeBot;
let stopping;
let canvaBridge;
const events = createBotEventTracker();

async function closeServices() {
  canvaBridge?.close();
  if (tunnel) await tunnel.close().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
}

async function main() {
  const config = settings();
  canvaBridge = createCanvaBridge(config.apiKey);
  server = await startWebhookServer(config.port, events.handle, canvaBridge.handle);
  let publicBaseUrl;
  if (!config.callbackUrl) {
    tunnel = await startNgrokTunnel(config.port);
    publicBaseUrl = tunnel.url().replace(/\/$/, '');
    config.callbackUrl = `${publicBaseUrl}/webhooks/meetstream`;
  } else {
    publicBaseUrl = new URL(config.callbackUrl).origin;
  }
  config.mcpUrl = `${publicBaseUrl}/mcp`;
  console.log(`✅ Bridge ready: ${config.mcpUrl}`);
  if (config.adapterOnly) return;
  const agent = await fetchAgentConfig(config.apiKey, config.agentConfigId);
  validateAgentConfig(agent, config.mcpUrl);
  if (stopping) return;
  console.log('✅ Agent ready: pipeline · gpt-4.1-mini · chat · Deepgram nova-3 · wake 30s');
  if (stopping) return;
  const deployed = await deployBot(config);
  activeBot = { apiKey: config.apiKey, id: deployed.bot_id };
  console.log('⏳ Bot joining meeting');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const startup = isMain
  ? main().catch(async (error) => {
      console.error(`❌ ${error.message}`);
      await closeServices();
      process.exitCode = 1;
    })
  : Promise.resolve();

async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    await startup;
    if (activeBot) {
      try {
        console.log('⏳ Removing bot');
        await removeBot(activeBot.apiKey, activeBot.id, events.waitForTerminal);
        console.log('✅ Bot removed; shutdown complete');
      } catch (error) {
        process.exitCode = 1;
        console.error(`❌ ${error.message}`);
      }
    }
    await closeServices();
  })();
  return stopping;
}

if (isMain) {
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
