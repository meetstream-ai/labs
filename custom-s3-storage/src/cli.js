// Tiny argv parser. No dependency needed for four subcommands.

export const USAGE = `
custom-s3-storage - point MeetStream at your own S3 bucket

Usage
  node index.js <command> [options]

Commands
  set        Save the storage config, then read it back to confirm
             (PUT /admin/configs?config_type=storage, then GET /admin/configs)
  show       Print the current storage config
             (GET /admin/configs)
  delete     Remove the config and the stored credentials
             (DELETE /admin/configs?key_name=aws)
  record     Send a bot into MEETING_LINK, wait for it to finish, then list what
             MeetStream wrote into your bucket

set options
  --skip-preflight   Skip the local HeadBucket check and send the credentials
                     to MeetStream straight away
  --dry-run          Print the redacted request body and exit without calling the API

delete options
  --yes              Required. New bots go back to the MeetStream platform bucket.
  --key-name <name>  Defaults to "aws", the only value the API accepts today.

record options
  --skip-verify      Do not list the bucket afterwards, just print where to look

global options
  --json             Print raw JSON instead of the formatted view
  --help             Show this text

Examples
  node index.js set --dry-run
  node index.js set
  node index.js show
  node index.js record
  node index.js delete --yes
`.trim();

const VALUE_FLAGS = new Set(['--key-name']);
const BOOLEAN_FLAGS = new Set(['--yes', '--json', '--dry-run', '--skip-preflight', '--skip-verify', '--help', '-h']);

export function parseArgs(argv) {
  const result = { command: '', positional: [], flags: {} };

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];

    // Positional: the first one is the command, the rest are arguments to it.
    if (!token.startsWith('-')) {
      if (result.command) result.positional.push(token);
      else result.command = token;
      continue;
    }

    if (BOOLEAN_FLAGS.has(token)) {
      result.flags[normalize(token)] = true;
      continue;
    }

    // Accept both "--flag value" and "--flag=value".
    const equals = token.indexOf('=');
    const name = equals > 0 ? token.slice(0, equals) : token;
    if (!VALUE_FLAGS.has(name)) throw new Error(`Unknown option ${name}. Run "node index.js --help".`);

    const value = equals > 0 ? token.slice(equals + 1) : argv[++index];
    if (value === undefined) throw new Error(`${name} needs a value.`);
    result.flags[normalize(name)] = value;
  }

  return result;
}

function normalize(flag) {
  if (flag === '-h') return 'help';
  return flag.replace(/^--?/, '').replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}
