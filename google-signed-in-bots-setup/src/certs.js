/**
 * Generates the self-signed SAML certificate / private key pair that the
 * Google Workspace legacy SSO profile and the MeetStream integration need.
 *
 * This is exactly the command from the docs:
 *   openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -sha256 -days 3650 -nodes
 *
 * The key pair is generated locally and never sent anywhere by this script.
 * You upload it yourself in the MeetStream dashboard (Integrations ->
 * Google Signed-In Bots), once per login email.
 */

import { execFile } from 'node:child_process';
import { mkdir, access, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function exists(target) {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function opensslAvailable() {
  try {
    const { stdout } = await run('openssl', ['version']);
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.dir       directory to write key.pem / cert.pem into
 * @param {string} opts.subject   OpenSSL subject string, e.g. "/CN=acme.com/O=Acme"
 * @param {number} opts.days      certificate validity in days
 * @param {boolean} opts.force    overwrite existing files
 */
export async function generateCertPair({ dir, subject, days = 3650, force = false }) {
  const version = await opensslAvailable();
  if (!version) {
    throw new Error(
      'openssl was not found on your PATH. Install OpenSSL (macOS: `brew install openssl`, ' +
        'Debian/Ubuntu: `apt-get install openssl`) and run this command again.'
    );
  }

  await mkdir(dir, { recursive: true });
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');

  if (!force && ((await exists(keyPath)) || (await exists(certPath)))) {
    throw new Error(
      `${keyPath} or ${certPath} already exists. Re-run with --force to overwrite them, or point ` +
        'CERT_DIR at a different directory. Never regenerate a cert that is already uploaded to ' +
        'Google Workspace without re-uploading the new one on both sides.'
    );
  }

  const args = [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-sha256',
    '-days',
    String(days),
    '-nodes',
  ];
  if (subject) args.push('-subj', subject);

  try {
    await run('openssl', args);
  } catch (cause) {
    const detail = (cause.stderr || cause.message || '').trim();
    throw new Error(`openssl failed to generate the key pair: ${detail}`);
  }

  // Private key should not be world readable.
  await chmod(keyPath, 0o600);

  return { keyPath, certPath, version, days };
}
