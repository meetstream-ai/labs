#!/usr/bin/env node
// MeetStream Labs: hosted Zoom OAuth connections.
//
// Lets one of your end users connect their own Zoom account so MeetStream bots
// can join meetings on their behalf:
//
//   authorize-url  GET    /zoom/oauth/authorize-url?redirect_uri=&state=
//   connect        POST   /zoom/oauth/connections          { code, redirect_uri, metadata? }
//   list           GET    /zoom/oauth/connections
//   get            GET    /zoom/oauth/connections/{zoom_user_id}
//   delete         DELETE /zoom/oauth/connections/{zoom_user_id}
//
// MeetStream stores and refreshes the Zoom tokens. Your side only ever holds
// the returned zoom_user_id, which is what you pass on create_bot.

import 'dotenv/config';
import { MeetStreamError } from './src/api.js';
import { parseArgs, USAGE } from './src/cli.js';
import {
  commandAuthorizeUrl,
  commandConnect,
  commandDelete,
  commandGet,
  commandList
} from './src/commands.js';

const PLACEHOLDER = /^your_.+_here$/i;

function readApiKey() {
  const key = process.env.MEETSTREAM_API_KEY?.trim();
  if (!key || PLACEHOLDER.test(key)) {
    throw new Error(
      'MEETSTREAM_API_KEY is missing from .env. Copy .env.example to .env and paste a real key from https://app.meetstream.ai.'
    );
  }
  return key;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.help || !args.command) {
    console.log(USAGE);
    return;
  }

  const apiKey = readApiKey();
  const options = { flags: args.flags, meta: args.meta, json: Boolean(args.flags.json) };
  const [firstPositional] = args.positional;

  switch (args.command) {
    case 'connect':
      return commandConnect(apiKey, options);
    case 'authorize-url':
      return commandAuthorizeUrl(apiKey, options);
    case 'list':
      return commandList(apiKey, options);
    case 'get':
      return commandGet(apiKey, firstPositional, options);
    case 'delete':
      return commandDelete(apiKey, firstPositional, options);
    default:
      throw new Error(`Unknown command "${args.command}". Run "node index.js --help".`);
  }
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(`[!!] ${error.message}`);
  if (error instanceof MeetStreamError && error.status === 404) {
    console.error('     Run "node index.js list" to see the zoom_user_id values that exist.');
  }
  if (error instanceof MeetStreamError && error.status === 400) {
    console.error('     Authorization codes are single-use and short-lived. Run "connect" again for a fresh one.');
  }
});
