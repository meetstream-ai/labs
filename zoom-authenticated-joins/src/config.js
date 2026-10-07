// Environment loading and validation. Everything fails fast with a message that
// says which variable to fix, instead of failing later inside a Zoom call.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLACEHOLDER = /^your_.+_here$/i;
// Relative DATA_DIR values resolve against the template folder, not the shell's cwd.
const TEMPLATE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

function read(name) {
  const value = process.env[name]?.trim();
  if (!value || PLACEHOLDER.test(value) || value.includes('your-subdomain')) return '';
  return value;
}

function requireVars(names, context) {
  const missing = names.filter((name) => !read(name));
  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.join(', ')} in .env (needed for ${context}). ` +
        'Copy .env.example to .env and fill in real values.'
    );
  }
}

/**
 * Validate a URL that MeetStream's bot (running in AWS) must be able to reach:
 * https, a real host, not localhost. Returns the URL without a trailing slash.
 */
export function assertPublicHttpsUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL: "${value}"`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${name} must use https (MeetStream rejects http token URLs). Got "${url.protocol}".`);
  }
  if (!url.hostname) throw new Error(`${name} must include a host.`);
  if (LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(
      `${name} points at ${url.hostname}. MeetStream bots run in AWS and cannot reach your machine. ` +
        'Expose this server with `ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000` and use that https URL.'
    );
  }
  return value.replace(/\/+$/, '');
}

function readPort() {
  const raw = read('PORT') || '3000';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a number between 1 and 65535, got "${raw}".`);
  }
  return port;
}

/** Config for the token server (`node index.js` / `node index.js serve`). */
export function loadServerConfig() {
  requireVars(['ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET', 'PUBLIC_BASE_URL', 'MINT_SHARED_SECRET'], 'the token server');

  const publicBaseUrl = assertPublicHttpsUrl(read('PUBLIC_BASE_URL'), 'PUBLIC_BASE_URL');
  const redirectUri = read('ZOOM_REDIRECT_URI') || `${publicBaseUrl}/zoom/callback`;

  let redirectPath;
  try {
    redirectPath = new URL(redirectUri).pathname || '/';
  } catch {
    throw new Error(`ZOOM_REDIRECT_URI is not a valid URL: "${redirectUri}"`);
  }

  const mintSecret = read('MINT_SHARED_SECRET');
  if (mintSecret.length < 32) {
    console.warn(
      '[warn] MINT_SHARED_SECRET is shorter than 32 characters. Anyone who guesses it can mint Zoom tokens ' +
        'for your users. Generate one with: openssl rand -hex 32'
    );
  }

  return {
    port: readPort(),
    publicBaseUrl,
    redirectUri,
    redirectPath,
    mintSecret,
    zoomClientId: read('ZOOM_CLIENT_ID'),
    zoomClientSecret: read('ZOOM_CLIENT_SECRET'),
    dataDir: path.resolve(TEMPLATE_ROOT, read('DATA_DIR') || 'data')
  };
}

/** Config for `node index.js create-bot`. Needs no Zoom credentials; --dry-run needs no API key. */
export function loadCreateBotConfig({ dryRun = false } = {}) {
  requireVars(
    dryRun ? ['PUBLIC_BASE_URL', 'MINT_SHARED_SECRET'] : ['MEETSTREAM_API_KEY', 'PUBLIC_BASE_URL', 'MINT_SHARED_SECRET'],
    'create-bot'
  );
  return {
    apiKey: read('MEETSTREAM_API_KEY'),
    apiBaseUrl: (read('MEETSTREAM_API_BASE_URL') || 'https://api.meetstream.ai/api/v1').replace(/\/+$/, ''),
    publicBaseUrl: assertPublicHttpsUrl(read('PUBLIC_BASE_URL'), 'PUBLIC_BASE_URL'),
    mintSecret: read('MINT_SHARED_SECRET')
  };
}
