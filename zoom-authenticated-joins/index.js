#!/usr/bin/env node
// MeetStream Labs: Zoom authenticated joins (ZAK and OBF).
//
// By default a MeetStream bot joins Zoom as a guest. To join as a signed-in
// Zoom user (ZAK), or on behalf of a user who is already in the meeting (OBF),
// you run Zoom OAuth yourself and host a small "mint" URL. You pass that URL
// on create_bot as zoom.zak_url or zoom.obf_url, and the bot calls it at join
// time to get a fresh token. Your refresh tokens never leave your server.
//
//   node index.js                 run the token server (OAuth + mint endpoints)
//   node index.js create-bot ...  send a bot that uses the mint URL

import 'dotenv/config';

import { CREATE_BOT_USAGE, createBot, parseCreateBotArgs, scrubSecrets } from './src/create-bot.js';
import { loadCreateBotConfig, loadServerConfig } from './src/config.js';
import { createApp } from './src/server.js';

const USAGE = `
zoom-authenticated-joins: host the Zoom token URL MeetStream bots call at join time

  node index.js [serve]         Start the token server
  node index.js create-bot ...  Create a bot that joins with zak_url or obf_url
  node index.js --help          This text

${CREATE_BOT_USAGE}
`.trim();

function serve() {
  const config = loadServerConfig();
  const app = createApp(config);

  const server = app.listen(config.port, () => {
    const base = config.publicBaseUrl;
    console.log(`Token server listening on http://localhost:${config.port}`);
    console.log(`Public URL (tunnel)   ${base}  ->  localhost:${config.port}`);
    console.log(`OAuth redirect URI    ${config.redirectUri}   (register this exact URL on your Zoom app)`);
    console.log(`Refresh tokens file   ${config.dataDir}/zoom-tokens.json`);
    console.log('');
    console.log('1. Connect a Zoom user once (open in their browser):');
    console.log(`     ${base}/zoom/connect?user_id=alice&auth=<MINT_SHARED_SECRET>`);
    console.log('2. Test the mint without a bot:');
    console.log(`     curl -sS -D - -H "X-Bot-Id: test-bot" "${base}/zoom/zak?user_id=alice&auth=<MINT_SHARED_SECRET>"`);
    console.log('3. Send a bot:');
    console.log('     node index.js create-bot --meeting "https://zoom.us/j/..." --mode zak --user alice');
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[!!] Port ${config.port} is already in use. Set PORT to something else and point the tunnel there.`);
    } else {
      console.error(`[!!] ${error.message}`);
    }
    process.exit(1);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE);
    return;
  }
  if (!command || command === 'serve') {
    serve();
    return;
  }
  if (command === 'create-bot') {
    const flags = parseCreateBotArgs(rest);
    if (flags.help) {
      console.log(CREATE_BOT_USAGE);
      return;
    }
    await createBot(loadCreateBotConfig({ dryRun: flags.dryRun }), flags);
    return;
  }
  throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
}

main().catch((error) => {
  process.exitCode = 1;
  // Never let a mint secret, Zoom passcode or client secret reach the terminal.
  console.error(
    `[!!] ${scrubSecrets(error.message, { mintSecret: process.env.MINT_SHARED_SECRET })
      .split(process.env.ZOOM_CLIENT_SECRET || '\u0000')
      .join('***')}`
  );
});
