import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  statSync,
  rmSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { execFileSync } from 'node:child_process';
import { saveSetting, ask } from '../src/setup.js';

test('private settings preserve punctuation, existing values and permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-settings-'));
  const file = join(dir, '.env');
  try {
    saveSetting(file, 'OTHER_KEY', 'keep-me');
    for (const value of [
      'secret#with$dollars',
      'path with spaces',
      'a\'quote"and`tick',
      '/tmp/a\\b',
    ]) {
      saveSetting(file, 'DEEPSEEK_API_KEY', value);
      assert.deepEqual(parseEnv(readFileSync(file, 'utf8')), {
        OTHER_KEY: 'keep-me',
        DEEPSEEK_API_KEY: value,
      });
    }
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.throws(
      () => saveSetting(file, 'DEEPSEEK_API_KEY', 'value\nINJECTED=yes'),
      /Invalid setting/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('missing interactive settings fail clearly when input is unavailable', async () => {
  await assert.rejects(ask('DEEPSEEK_API_KEY'), /interactive terminal/);
});
test('first-start bootstrap installs once, without forwarding npm CLI-only script permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-bootstrap-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    copyFileSync('scripts/bootstrap.js', join(dir, 'scripts/bootstrap.js'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ type: 'module', dependencies: { zod: '4.6.7' } }),
    );
    const npm = join(dir, 'npm-fixture.cjs');
    writeFileSync(
      npm,
      `const fs=require('node:fs');const assert=require('node:assert/strict');
assert.equal(process.env.npm_config_allow_scripts,undefined);assert.equal(process.env.NPM_CONFIG_ALLOW_SCRIPTS,undefined);
assert.ok(process.argv.includes('--ignore-scripts'));fs.mkdirSync('node_modules/zod',{recursive:true});
fs.writeFileSync('node_modules/zod/package.json',JSON.stringify({version:'4.6.7'}));fs.appendFileSync('installs','1');`,
    );
    const env = {
      ...process.env,
      npm_execpath: npm,
      npm_config_allow_scripts: '*',
      NPM_CONFIG_ALLOW_SCRIPTS: '*',
    };
    for (let i = 0; i < 2; i++)
      execFileSync(process.execPath, ['scripts/bootstrap.js'], { cwd: dir, env });
    assert.equal(readFileSync(join(dir, 'installs'), 'utf8'), '1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
