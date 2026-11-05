/**
 * Tiny argv parser and terminal prompts - no dependency needed for a handful of flags.
 *
 * Passwords are deliberately NOT accepted as flags: anything typed on the
 * command line lands in shell history. They come from environment variables
 * or from the hidden prompt below.
 */

import process from 'node:process';
import readline from 'node:readline/promises';

const SECRET_FLAGS = new Set(['password', 'newPassword']);

export function parseArgs(argv) {
  const positional = [];
  const flags = Object.create(null);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '-h') {
      flags.help = true;
      continue;
    }
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    let key = token.slice(2);
    let value;

    const eq = key.indexOf('=');
    if (eq !== -1) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }

    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (SECRET_FLAGS.has(camel)) {
      throw new Error(
        `--${key} is not supported: a password on the command line ends up in shell history. ` +
          'Put it in an environment variable (see .env.example) or omit it to be prompted.'
      );
    }

    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        value = true; // boolean flag
      } else {
        value = next;
        i += 1;
      }
    }

    flags[camel] = value;
  }

  return { positional, flags };
}

/** A string-valued flag, or undefined when absent or given without a value. */
export function stringFlag(flags, name) {
  const value = flags[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Typed confirmation for destructive calls, the same pattern as the
 * delete-bot-data template: the user has to type the exact target back.
 * Returns false (never throws) when it cannot ask.
 */
export async function typedConfirm(expected, { what }) {
  if (!process.stdin.isTTY) {
    console.error('Not an interactive terminal, so the confirmation prompt cannot run.');
    console.error('Re-run with --force if you are certain, or run it interactively.');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('This is permanent. There is no undo.');
    const answer = await rl.question(`Type the ${what} to confirm (${expected}): `);
    return answer.trim() === expected;
  } finally {
    rl.close();
  }
}

/**
 * Read a secret from the terminal without echoing it. Needs a TTY; returns
 * null when there is none so the caller can explain which env var to set.
 */
export async function promptSecret(question) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return null;

  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '') return finish();
        if (ch === '') return finish(new Error('Cancelled.'));
        if (ch === '' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
