import { readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export function saveSetting(file, name, value) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name) || /[\r\n\0]/.test(value)) throw new Error('Invalid setting');
  // Let Node's own dotenv parser choose a lossless representation, including paths with spaces.
  const encoded = [value, `'${value}'`, `"${value}"`, '`' + value + '`'].find(
    (v) => parseEnv(`${name}=${v}`)[name] === value,
  );
  if (encoded === undefined)
    throw new Error(`Set ${name} through your shell; this value cannot be saved in .env`);
  const line = `${name}=${encoded}`;
  const previous = existsSync(file)
    ? readFileSync(file, 'utf8')
    : '# Private bridge settings. Do not share this file.\n';
  const pattern = new RegExp(`^(?:export\\s+)?${name}\\s*=.*$`, 'gm');
  const next = pattern.test(previous)
    ? previous.replace(pattern, () => line)
    : previous.trimEnd() + '\n' + line + '\n';
  const temp = file + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, next, { mode: 0o600, flag: 'wx' });
  renameSync(temp, file);
  chmodSync(file, 0o600);
}

export async function ask(label, { secret = false, signal } = {}) {
  if (!process.stdin.isTTY)
    throw new Error(
      `${label} is missing. Set it in .env or run npm start in an interactive terminal.`,
    );
  signal?.throwIfAborted();
  const interrupted = new AbortController();
  const rl = createInterface({
    input: process.stdin,
    output: secret
      ? new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        })
      : process.stdout,
    terminal: true,
  });
  rl.once('SIGINT', () => interrupted.abort());
  const closed = () => interrupted.abort();
  rl.once('close', closed);
  try {
    if (secret) process.stdout.write(label + ' (hidden): ');
    return (
      await rl.question(secret ? '' : label + ': ', {
        signal: signal ? AbortSignal.any([signal, interrupted.signal]) : interrupted.signal,
      })
    ).trim();
  } finally {
    rl.removeListener('close', closed);
    rl.close();
    if (secret) process.stdout.write('\n');
  }
}

export async function setting(
  name,
  label,
  { secret = false, save = true, signal, file = resolve('.env') } = {},
) {
  if (process.env[name]?.trim()) return process.env[name].trim();
  const value = await ask(`${label} (${name})`, { secret, signal });
  if (!value) throw new Error(`${name} is required. Run npm start again when it is available.`);
  if (save) saveSetting(file, name, value);
  process.env[name] = value;
  return value;
}
