#!/usr/bin/env node
// MeetStream Labs: bring your own S3 bucket (BYOB).
//
// MeetStream writes bot media - audio, video, transcripts, metadata - straight
// into a bucket you own. That is a native account-level setting, not a relay:
//
//   set     PUT    /admin/configs?config_type=storage   StorageConfigRequest
//   show    GET    /admin/configs
//   delete  DELETE /admin/configs?key_name=aws
//   record  create a bot, then confirm the files landed in your bucket
//
// The config carries a real S3 secret key. It is read from the environment,
// sent to MeetStream, and never printed by this template.

import 'dotenv/config';

import { MeetStreamError } from './src/client.js';
import { parseArgs, USAGE } from './src/cli.js';
import { commandDelete, commandRecord, commandSet, commandShow } from './src/commands.js';
import { log } from './src/log.js';

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.help || !args.command) {
    console.log(USAGE);
    return;
  }

  const options = { flags: args.flags, json: Boolean(args.flags.json) };

  switch (args.command) {
    case 'set':
      return commandSet(options);
    case 'show':
      return commandShow(options);
    case 'delete':
      return commandDelete(options);
    case 'record':
      return commandRecord(options);
    default:
      throw new Error(`Unknown command "${args.command}". Run "node index.js --help".`);
  }
}

main().catch((error) => {
  process.exitCode = 1;
  log.error(error.message);

  if (error instanceof MeetStreamError && error.status === 400) {
    log.error(
      'MeetStream validates the bucket and credentials before saving, so a 400 here usually ' +
        'means the bucket name, region, or key pair is wrong rather than the JSON.'
    );
  }
  if (error instanceof MeetStreamError && error.status === 403) {
    log.error('Check MEETSTREAM_API_KEY, and that bring your own bucket is enabled on your account.');
  }
});
