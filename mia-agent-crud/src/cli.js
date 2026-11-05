// Tiny argv parser. No dependency needed for five subcommands.

export const USAGE = `
mia - manage saved MeetStream Infrastructure Agent configs

Usage
  node index.js <command> [options]

Commands
  list                         List every saved agent config        (GET /mia)
  get <agent_config_id>        Show one agent config                (GET /mia?agent_config_id=...)
  create                       Save a new agent config              (POST /mia)
  update <agent_config_id>     Change parts of an agent config      (PUT /mia)
  delete <agent_config_id>     Remove an agent config               (DELETE /mia?agent_config_id=...)

create options
  --preset <name>       Start from a built-in preset: pipeline | realtime | wake-word
  --file <path.json>    Load the full request body from a JSON file
  --name <text>         Override agent_name
  --model <id>          Override model.model
  --prompt <text>       Override model.system_prompt
  --set <path=value>    Override any field, repeatable. Dotted path, JSON or plain value.
  --dry-run             Print the request body and exit without calling the API

  --preset and --file can be combined: the file is merged on top of the preset.

update options
  --file <path.json>    Merge this JSON object into the config
  --name <text>         Change agent_name
  --model <id>          Change model.model
  --prompt <text>       Change model.system_prompt
  --set <path=value>    Change any field, repeatable
  --dry-run             Print the request body and exit without calling the API

  PUT sends only the blocks you name. Blocks you do not mention are left as they are.

delete options
  --yes                 Required. Deleting an agent config cannot be undone.

global options
  --json                Print raw JSON instead of the formatted view
  --help                Show this text

Examples
  node index.js list
  node index.js create --preset pipeline --name "Support Bot"
  node index.js create --preset wake-word --set wake_word.words='["hey acme","ok acme"]'
  node index.js get 1f2e3d4c-...
  node index.js update 1f2e3d4c-... --prompt "Answer in one sentence."
  node index.js update 1f2e3d4c-... --set voice.voice_id=onyx
  node index.js delete 1f2e3d4c-... --yes
`.trim();

const VALUE_FLAGS = new Set(['--preset', '--file', '--name', '--model', '--prompt', '--set']);
const BOOLEAN_FLAGS = new Set(['--yes', '--dry-run', '--json', '--help', '-h']);

export function parseArgs(argv) {
  const result = { command: '', positional: [], sets: [], flags: {} };

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

    if (name === '--set') result.sets.push(value);
    else result.flags[normalize(name)] = value;
  }

  return result;
}

function normalize(flag) {
  if (flag === '-h') return 'help';
  return flag.replace(/^--?/, '').replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

/**
 * Apply a `--set path=value` override onto an object.
 * Values are parsed as JSON when possible so booleans, numbers, and arrays work:
 *   --set wake_word.enabled=true
 *   --set wake_word.words='["hey acme"]'
 *   --set model.system_prompt="Be brief."
 */
export function applySet(target, assignment) {
  const equals = assignment.indexOf('=');
  if (equals < 1) throw new Error(`--set expects path=value, got "${assignment}".`);
  const path = assignment.slice(0, equals).split('.').filter(Boolean);
  const rawValue = assignment.slice(equals + 1);
  if (!path.length) throw new Error(`--set expects path=value, got "${assignment}".`);

  let value;
  try {
    value = JSON.parse(rawValue);
  } catch {
    value = rawValue;
  }

  let cursor = target;
  for (const key of path.slice(0, -1)) {
    if (typeof cursor[key] !== 'object' || cursor[key] === null || Array.isArray(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[path[path.length - 1]] = value;
  return target;
}

/** Deep merge for combining a preset with a --file body. Arrays are replaced, not concatenated. */
export function mergeDeep(base, patch) {
  const output = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    const existing = output[key];
    const bothPlainObjects =
      value && typeof value === 'object' && !Array.isArray(value) &&
      existing && typeof existing === 'object' && !Array.isArray(existing);
    output[key] = bothPlainObjects ? mergeDeep(existing, value) : value;
  }
  return output;
}
