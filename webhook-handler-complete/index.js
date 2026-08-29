#!/usr/bin/env node
/**
 * MeetStream Labs - webhook-handler-complete
 *
 * A reference webhook receiver that handles every documented MeetStream event
 * correctly, with idempotent delivery handling.
 *
 *   node index.js              start the receiver
 *   node index.js --simulate   start it and replay every lifecycle scenario locally
 *   node index.js --create-bot start it and send a real bot at MEETING_LINK
 *                              (requires PUBLIC_URL and MEETSTREAM_API_KEY)
 */
import { loadConfig } from './src/config.js';
import { createServer } from './src/server.js';
import { MeetStream } from './src/meetstream.js';
import { allScenarios, replay } from './src/simulate.js';
import { log } from './src/logger.js';

const args = new Set(process.argv.slice(2));
const SIMULATE = args.has('--simulate');
const CREATE_BOT = args.has('--create-bot');

const cfg = loadConfig({ requireApiKey: CREATE_BOT });

/** Set when --create-bot launched a real bot, so Ctrl+C can clean it up. */
let activeBot = null;

const { app, bots } = createServer({
  webhookPath: cfg.webhookPath,
  streamingOnly: cfg.streamingOnly,
});

const server = app.listen(cfg.port, async () => {
  log.banner('MeetStream webhook receiver');
  log.detail('listening', `http://localhost:${cfg.port}`);
  log.detail('webhook path', `POST ${cfg.webhookPath}`);
  log.detail('health', `GET  /health`);
  log.detail('inspect', `GET  /bots  and  GET /bots/:botId`);
  log.detail('provider mode', `${cfg.provider} (${cfg.streamingOnly ? 'streaming-only' : 'post-call'})`);
  if (cfg.publicUrl) log.detail('public url', `${cfg.publicUrl}${cfg.webhookPath}`);
  console.log('');

  if (SIMULATE) await runSimulation();
  else if (CREATE_BOT) await launchBot();
  else {
    log.info('Waiting for deliveries. Point a bot at this URL with:');
    log.info(`  create_bot { "callback_url": "${cfg.publicUrl || 'https://<your-public-url>'}${cfg.webhookPath}" }`);
    log.info('No public URL yet? See the webhook-local-tunnel template.');
    log.info('Want to see every branch fire right now? Run:  node index.js --simulate');
  }
});

async function runSimulation() {
  log.banner('SIMULATION (synthetic envelopes, no API calls)');
  log.info('Replaying every documented lifecycle path against this server.');
  console.log('');

  const url = `http://localhost:${cfg.port}${cfg.webhookPath}`;
  const results = await replay(allScenarios(), url, { delayMs: 80 });

  log.banner('Simulation results');
  const acked = results.filter((r) => r.status === 200).length;
  log.detail('deliveries sent', String(results.length));
  log.detail('acked 200', String(acked));
  log.detail('bots tracked', String(bots.size));
  console.log('');
  for (const [botId, state] of bots) {
    const path = state.streamingOnly ? 'streaming-only' : 'post-call';
    const outcome = state.outcome ? `${state.outcome.botStatus}` : 'no bot.stopped seen';
    console.log(
      `  ${botId.padEnd(20)} ${String(path).padEnd(15)} events=${String(state.events.length).padEnd(3)} outcome=${outcome} finished=${state.finished}`,
    );
  }
  console.log('');
  log.ok('Simulation complete. Server is still up. Ctrl+C to exit.');
}

async function launchBot() {
  if (!cfg.publicUrl) {
    log.error('PUBLIC_URL is required with --create-bot. MeetStream must reach your webhook over HTTPS.');
    log.error('Use the webhook-local-tunnel template to get one, then set PUBLIC_URL in .env.');
    process.exit(1);
  }
  if (!/^https:\/\//i.test(cfg.publicUrl)) {
    log.error(`PUBLIC_URL must be https. Got: ${cfg.publicUrl}`);
    process.exit(1);
  }
  if (!cfg.meetingLink) {
    log.error('MEETING_LINK is required with --create-bot.');
    process.exit(1);
  }

  const client = new MeetStream({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
  const callbackUrl = `${cfg.publicUrl}${cfg.webhookPath}`;

  try {
    const { data, status, replay: wasReplay } = await client.createBot({
      meetingLink: cfg.meetingLink,
      botName: cfg.botName,
      callbackUrl,
      videoRequired: cfg.videoRequired,
      provider: cfg.provider,
      // Stamp the pipeline mode so the handler knows where the event stream
      // ends. Webhooks never carry the provider. Values MUST be strings.
      customAttributes: {
        streaming_only: String(cfg.streamingOnly),
        template: 'webhook-handler-complete',
      },
    });

    log.ok(`bot created (HTTP ${status}${wasReplay ? ', idempotent replay' : ''})`);
    log.detail('bot_id', data?.bot_id ?? 'n/a');
    log.detail(
      'transcript_id',
      data?.transcript_id ??
        'null (expected for meeting_captions and streaming-only providers)',
    );
    log.detail('callback_url', callbackUrl);
    console.log('');
    log.info('Watching for events. Ctrl+C removes the bot and exits.');
    activeBot = { client, botId: data?.bot_id };
  } catch (err) {
    log.error(`create_bot failed (HTTP ${err.status ?? '?'}): ${err.message}`);
    if (err.status === 401) log.error('401 means no API key was sent. Check MEETSTREAM_API_KEY.');
    if (err.status === 403) log.error('403 means the key was sent but is not valid.');
    if (err.status === 400) log.error('400 is a validation error. The message above names the field.');
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  log.info('shutting down');
  if (activeBot?.botId) {
    log.info(`removing bot ${activeBot.botId} ...`);
    try {
      await activeBot.client.removeBot(activeBot.botId);
      log.ok('bot removed');
    } catch (err) {
      log.warn(`remove_bot failed: ${err.message}`);
    }
  }
  server.close(() => process.exit(0));
  // Do not hang forever if a socket is stuck open.
  setTimeout(() => process.exit(0), 3000).unref();
});
