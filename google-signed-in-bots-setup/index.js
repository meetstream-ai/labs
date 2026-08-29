#!/usr/bin/env node
/**
 * MeetStream Labs - Google Signed-In Bots, end to end.
 *
 *   node index.js gen-cert         generate the SAML key/cert pair with openssl
 *   node index.js register-domain  POST /google-login-domains
 *   node index.js status           show the configured domains and logins
 *   node index.js create-bot       create_bot with google_meet.login_required
 *   node index.js verify           read-only pre-flight before you send a real bot
 *
 * Run `node index.js` with no arguments for the full checklist.
 */

import 'dotenv/config';
import path from 'node:path';
import process from 'node:process';

import {
  ConfigError,
  MeetStreamError,
  boolEnv,
  createClient,
  intEnv,
  optionalEnv,
} from './src/client.js';
import { generateCertPair, opensslAvailable } from './src/certs.js';
import { createDomain, getDomain, listDomains, listLogins } from './src/domains.js';
import { createSignedInBot } from './src/bot.js';

const SSO_SIGN_IN_URL = 'https://api.meetstream.ai/api/v1/bot/gmeet-sign-in';
const SSO_SIGN_OUT_URL = 'https://api.meetstream.ai/api/v1/bot/gmeet-sign-out';

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function printChecklist() {
  console.log(`
MeetStream - Google signed-in bots
==================================

A signed-in bot logs into a real Google Workspace account before joining, so it
shows up as a named participant instead of an anonymous guest. If that account is
on the calendar invite it skips the Google Meet lobby entirely.

One-time setup (details in README.md):

  1. Google Workspace Admin -> Security -> Authentication -> SSO with third-party IdPs
     -> Legacy SSO profile. Enable it and set:
         Sign-in page URL : ${SSO_SIGN_IN_URL}
         Sign-out page URL: ${SSO_SIGN_OUT_URL}
     Also enable "Domain-specific issuer".

  2. Generate the certificate pair:
         node index.js gen-cert

  3. MeetStream dashboard -> Integrations -> Google Signed-In Bots.
     Add your Workspace domain, then add each bot mail ID and upload
     cert.pem + key.pem for every mail ID you add.
     (The domain entry can also be created from the API: node index.js register-domain)

  4. Check what MeetStream has on file:
         node index.js status

  5. Send a signed-in bot:
         node index.js create-bot

Commands: gen-cert | register-domain | status | verify | create-bot
`);
}

async function cmdGenCert() {
  const dir = path.resolve(optionalEnv('CERT_DIR', './certs'));
  const subject = optionalEnv('CERT_SUBJECT');
  const days = intEnv('CERT_DAYS', { fallback: 3650, min: 1, max: 36500 });

  const version = await opensslAvailable();
  console.log(version ? `Using ${version}` : 'openssl not detected');

  const result = await generateCertPair({ dir, subject, days, force: flag('force') });

  console.log(`\nGenerated a ${result.days}-day self-signed pair:`);
  console.log(`  private key : ${result.keyPath}  (chmod 600 - keep this out of git)`);
  console.log(`  certificate : ${result.certPath}`);
  console.log(
    '\nUpload BOTH files in the MeetStream dashboard under Integrations -> Google Signed-In Bots,' +
      '\nonce for every mail ID you add under the domain. Upload the certificate to your Google' +
      '\nWorkspace legacy SSO profile as well ("Verification certificate").'
  );
}

async function cmdRegisterDomain(client) {
  const userId = optionalEnv('GOOGLE_DOMAIN_USER_ID');
  const name = optionalEnv('GOOGLE_DOMAIN_NAME');
  const loginMode = optionalEnv('GOOGLE_LOGIN_MODE');

  if (!userId || !name) {
    throw new ConfigError(
      'register-domain needs GOOGLE_DOMAIN_USER_ID and GOOGLE_DOMAIN_NAME in your .env. ' +
        'See .env.example - these map to the documented `user_id` and `name` body fields of ' +
        'POST /google-login-domains.'
    );
  }

  const { domain, replayed } = await createDomain(client, { userId, name, loginMode });
  console.log(replayed ? 'Domain already registered (507 replay).' : 'Domain registered.');
  console.log(JSON.stringify(domain, null, 2));
  console.log(
    '\nNext: add the bot mail IDs under this domain and upload cert.pem + key.pem for each one\n' +
      'in the dashboard (Integrations -> Google Signed-In Bots).'
  );
}

async function cmdStatus(client) {
  const domains = await listDomains(client);
  if (domains.length === 0) {
    console.log('No Google login domains configured yet. Run: node index.js register-domain');
  } else {
    console.log(`Configured domains (${domains.length}):`);
    for (const d of domains) {
      console.log(
        `  ${d.sso_workspace_domain ?? '(unknown domain)'}  name=${d.name ?? '-'}  ` +
          `login_mode=${d.login_mode ?? '-'}  logins=${d.login_count ?? '?'} ` +
          `(active ${d.active_login_count ?? '?'})  max_concurrent_per_login=${
            d.max_concurrent_per_login ?? '?'
          }`
      );
    }
  }

  const logins = await listLogins(client);
  console.log(`\nLogins (${logins.length}):`);
  for (const login of logins) {
    console.log(
      `  ${login.email ?? '(no email)'}  id=${login.login_id ?? '-'}  active=${login.is_active}  ` +
        `sessions=${login.active_sessions ?? 0}  last_test=${login.last_test_status ?? '-'}`
    );
  }
  if (logins.length === 0) {
    console.log(
      '  none - add mail IDs in the dashboard (Integrations -> Google Signed-In Bots) and upload\n' +
        '  cert.pem + key.pem for each.'
    );
  }
}

async function cmdVerify(client) {
  const domain = optionalEnv('GOOGLE_LOGIN_DOMAIN');
  const signInEmail = optionalEnv('SIGN_IN_EMAIL');

  if (!domain) {
    throw new ConfigError('verify needs GOOGLE_LOGIN_DOMAIN in your .env.');
  }

  let record;
  try {
    record = await getDomain(client, domain);
  } catch (error) {
    if (error instanceof MeetStreamError && error.status === 404) {
      console.error(
        `FAIL  "${domain}" is not configured on this API key. Run "node index.js status" to see ` +
          'what is, or add it in the dashboard.'
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  console.log(`OK    domain "${record.sso_workspace_domain ?? domain}" is configured.`);
  console.log(`      login_mode=${record.login_mode ?? '-'}`);

  const logins = Array.isArray(record.logins) ? record.logins : [];
  console.log(`      ${logins.length} login(s) attached.`);
  for (const login of logins) {
    console.log(
      `        ${login.email}  active=${login.is_active}  sessions=${login.active_sessions ?? 0}` +
        `  last_test=${login.last_test_status ?? '-'}`
    );
  }

  if (logins.length === 0) {
    console.error(
      'FAIL  no logins under this domain - a signed-in bot has no account to sign in with.'
    );
    process.exitCode = 1;
    return;
  }

  if (signInEmail) {
    const match = logins.find((l) => l.email?.toLowerCase() === signInEmail.toLowerCase());
    if (!match) {
      console.error(
        `FAIL  SIGN_IN_EMAIL "${signInEmail}" is not one of the logins under this domain.`
      );
      process.exitCode = 1;
      return;
    }
    if (match.is_active === false) {
      console.error(`FAIL  login "${signInEmail}" exists but is_active=false.`);
      process.exitCode = 1;
      return;
    }
    console.log(`OK    SIGN_IN_EMAIL "${signInEmail}" is an active login.`);
    console.log(
      `\nReminder: add ${signInEmail} to the Google Calendar invite so Meet treats the bot as an` +
        '\ninvited participant and lets it bypass the lobby.'
    );
  }
}

async function cmdCreateBot(client) {
  const meetingLink = optionalEnv('MEETING_LINK');
  const googleLoginDomain = optionalEnv('GOOGLE_LOGIN_DOMAIN');

  if (!meetingLink || !googleLoginDomain) {
    throw new ConfigError('create-bot needs MEETING_LINK and GOOGLE_LOGIN_DOMAIN in your .env.');
  }

  const { bot, replayed, request } = await createSignedInBot(client, {
    meetingLink,
    botName: optionalEnv('BOT_NAME', 'MeetStream Signed-In Bot'),
    googleLoginDomain,
    signInEmail: optionalEnv('SIGN_IN_EMAIL'),
    strictEmail: boolEnv('STRICT_EMAIL', false),
    videoRequired: boolEnv('VIDEO_REQUIRED', false),
    waitingRoomTimeout: intEnv('WAITING_ROOM_TIMEOUT', { min: 60, max: 600 }),
    callbackUrl: optionalEnv('CALLBACK_URL'),
  });

  console.log('Request sent:');
  console.log(JSON.stringify(request, null, 2));
  console.log(replayed ? '\nIdempotent replay (507) - the bot already exists.' : '\nBot created.');
  console.log(JSON.stringify(bot, null, 2));
  console.log(
    '\nThe bot signs in with the Google account, so Meet shows that account\'s name and avatar -' +
      '\nnot bot_name. Watch its progress with GET /bots/{bot_id}/status.'
  );
}

async function main() {
  const command = process.argv[2];

  if (!command || command === 'help' || command === '--help') {
    printChecklist();
    return;
  }

  if (command === 'gen-cert') {
    await cmdGenCert();
    return;
  }

  // Everything below talks to the API.
  const client = createClient();

  switch (command) {
    case 'register-domain':
      await cmdRegisterDomain(client);
      break;
    case 'status':
      await cmdStatus(client);
      break;
    case 'verify':
      await cmdVerify(client);
      break;
    case 'create-bot':
      await cmdCreateBot(client);
      break;
    default:
      console.error(`Unknown command "${command}".`);
      printChecklist();
      process.exitCode = 1;
  }
}

main().catch((error) => {
  if (error instanceof ConfigError) {
    console.error(`\nConfiguration error: ${error.message}`);
  } else if (error instanceof MeetStreamError) {
    console.error(`\n${error.message}`);
    if (error.status === 401) console.error('Your MEETSTREAM_API_KEY is missing or malformed.');
    if (error.status === 403) console.error('That API key is not valid for this workspace.');
  } else {
    console.error(`\n${error.stack ?? error.message}`);
  }
  process.exitCode = 1;
});
