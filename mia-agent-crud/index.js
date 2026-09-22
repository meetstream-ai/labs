#!/usr/bin/env node
// MeetStream Labs: MIA agent config admin CLI.
//
// Full lifecycle for saved MeetStream Infrastructure Agent configs:
//   create  POST   /mia
//   list    GET    /mia
//   get     GET    /mia?agent_config_id=...
//   update  PUT    /mia            (body carries agent_config_id)
//   delete  DELETE /mia?agent_config_id=...
//
// An agent config is attached to a meeting bot by passing its agent_config_id
// on create_bot. That single field is the whole integration: MeetStream hosts
// the agent bridge, so no websocket fields are involved.

import 'dotenv/config';
import { MeetStreamError } from './src/api.js';
import { commandCreate, commandDelete, commandGet, commandList, commandUpdate } from './src/commands.js';
import { parseArgs, USAGE } from './src/cli.js';

const PLACEHOLDER = /^your_.+_here$/i;

function readApiKey() {
  const key = process.env.MEETSTREAM_API_KEY?.trim();
  if (!key || PLACEHOLDER.test(key)) {
    throw new Error('MEETSTREAM_API_KEY is missing from .env. Copy .env.example to .env and paste a real key from https://app.meetstream.ai.');
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
  const options = { flags: args.flags, sets: args.sets, json: Boolean(args.flags.json) };
  const [firstPositional] = args.positional;

  switch (args.command) {
    case 'list':
      return commandList(apiKey, options);
    case 'get':
      return commandGet(apiKey, firstPositional, options);
    case 'create':
      return commandCreate(apiKey, options);
    case 'update':
      return commandUpdate(apiKey, firstPositional, options);
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
    console.error('     Run "node index.js list" to see the agent_config_id values that exist.');
  }
});
