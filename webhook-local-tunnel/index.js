#!/usr/bin/env node
/**
 * MeetStream Labs - webhook-local-tunnel
 *
 * Gets webhooks flowing to a server on your laptop:
 *   1. starts a local receiver
 *   2. opens a public HTTPS tunnel (ngrok or cloudflared)
 *   3. verifies delivery end to end with a synthetic POST
 *   4. optionally sends a real bot whose callback_url is that tunnel
 *
 *   node index.js               tunnel + verify, then wait for deliveries
 *   node index.js --create-bot  same, then create a real bot at MEETING_LINK
 *   node index.js --no-verify   skip the self-test
 */
import 'dotenv/config';
import { Tunnel, assertDeliverable } from './src/tunnel.js';
import { createServer } from './src/server.js';
import { verifyTunnel } from './src/verify.js';
import { MeetStream } from './src/meetstream.js';
import { log } from './src/logger.js';

const args = new Set(process.argv.slice(2));
const CREATE_BOT = args.has('--create-bot');
const SKIP_VERIFY = args.has('--no-verify');

const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhook';
const PROVIDER = process.env.TUNNEL_PROVIDER || 'ngrok';
const MANUAL_URL = (process.env.TUNNEL_URL || '').replace(/\/+$/, '');

if (CREATE_BOT && !process.env.MEETSTREAM_API_KEY) {
  console.error(
    'Missing MEETSTREAM_API_KEY. Copy .env.example to .env and set your key from https://app.meetstream.ai',
  );
  process.exit(1);
}
if (CREATE_BOT && !process.env.MEETING_LINK) {
  console.error('Missing MEETING_LINK. --create-bot needs a meeting for the bot to join.');
  process.exit(1);
}

const { app, deliveries, waitForNonce } = createServer({ webhookPath: WEBHOOK_PATH });

let tunnel = null;
let activeBot = null;

const server = app.listen(PORT, async () => {
  log.banner('MeetStream webhook tunnel');
  log.detail('local server', `http://localhost:${PORT}`);
  log.detail('webhook path', `POST ${WEBHOOK_PATH}`);
  log.detail('tunnel provider', PROVIDER);
  console.log('');

  let publicUrl;
  try {
    publicUrl = await resolvePublicUrl();
  } catch (err) {
    log.error(err.message);
    shutdown(1);
    return;
  }

  const callbackUrl = `${publicUrl}${WEBHOOK_PATH}`;
  log.banner('Public URL is live');
  log.detail('public url', publicUrl);
  log.detail('callback_url', callbackUrl);
  log.detail('use it as', `create_bot { "callback_url": "${callbackUrl}" }`);
  console.log('');

  if (!SKIP_VERIFY) {
    log.banner('Verifying delivery');
    const { ok, results } = await verifyTunnel({ publicUrl, webhookPath: WEBHOOK_PATH, waitForNonce });
    console.log('');
    for (const r of results) {
      console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.check}${r.detail ? `  (${r.detail})` : ''}`);
    }
    console.log('');
    if (!ok) {
      log.error('Tunnel is not usable as a callback_url yet. See Troubleshooting in the README.');
      shutdown(1);
      return;
    }
    log.ok('Tunnel verified. MeetStream can reach this machine.');
    console.log('');
  }

  if (CREATE_BOT) await launchBot(callbackUrl);
  else {
    log.info('Waiting for deliveries. Ctrl+C to stop.');
    log.info(`Inspect what arrived:  curl localhost:${PORT}/deliveries`);
  }
});

async function resolvePublicUrl() {
  if (PROVIDER === 'manual') {
    if (!MANUAL_URL) {
      throw new Error(
        'TUNNEL_PROVIDER=manual requires TUNNEL_URL. Start your own tunnel and paste its https URL there.',
      );
    }
    assertDeliverable(MANUAL_URL);
    log.info(`using TUNNEL_URL from the environment: ${MANUAL_URL}`);
    return MANUAL_URL;
  }

  tunnel = new Tunnel({ provider: PROVIDER, port: PORT });
  const url = await tunnel.start();
  // A tunnel provider could in principle hand back http. Refuse it loudly.
  return assertDeliverable(url).replace(/\/+$/, '');
}

async function launchBot(callbackUrl) {
  const client = new MeetStream({
    apiKey: process.env.MEETSTREAM_API_KEY,
    baseUrl: process.env.MEETSTREAM_BASE_URL || 'https://api.meetstream.ai/api/v1',
  });

  try {
    const { data, status, replay } = await client.createBot({
      meetingLink: process.env.MEETING_LINK,
      botName: process.env.BOT_NAME || 'Tunnel Test Bot',
      callbackUrl,
      videoRequired: process.env.VIDEO_REQUIRED === 'true',
    });
    log.ok(`bot created (HTTP ${status}${replay ? ', idempotent replay' : ''})`);
    log.detail('bot_id', data?.bot_id ?? 'n/a');
    log.detail('transcript_id', data?.transcript_id ?? 'null');
    console.log('');
    log.info('Events will print below as they arrive. Ctrl+C removes the bot and exits.');
    activeBot = { client, botId: data?.bot_id };
  } catch (err) {
    log.error(`create_bot failed (HTTP ${err.status ?? '?'}): ${err.message}`);
    if (err.status === 400 && /callback/i.test(err.message)) {
      log.error('The API rejected the callback_url. It must be a publicly reachable https URL.');
    }
    shutdown(1);
  }
}

function shutdown(code = 0) {
  tunnel?.stop();
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 3000).unref();
}

process.on('SIGINT', async () => {
  console.log('');
  log.info(`shutting down after ${deliveries.length} deliveries`);
  if (activeBot?.botId) {
    log.info(`removing bot ${activeBot.botId} ...`);
    try {
      await activeBot.client.removeBot(activeBot.botId);
      log.ok('bot removed');
    } catch (err) {
      log.warn(`remove_bot failed: ${err.message}`);
    }
  }
  shutdown(0);
});
