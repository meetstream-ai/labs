#!/usr/bin/env node
/**
 * MeetStream Labs - Google signed-in bot admin CLI.
 *
 * Manages the two resources behind Google signed-in bots:
 *   domains  /google-login-domains
 *   logins   /google-logins
 *
 * Run `node index.js help` for the command list.
 */

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import readline from 'node:readline/promises';

import { ConfigError, MeetStreamError, createClient, intEnv } from './src/client.js';
import { coerce, pairsToObject, parseArgs } from './src/cli.js';
import {
  createDomain,
  deleteDomain,
  getDomain,
  listDomains,
  updateDomain,
} from './src/domains.js';
import {
  createLogin,
  deleteLogin,
  listLogins,
  listLoginsForDomain,
  updateLogin,
} from './src/logins.js';
import { SESSIONS_PER_LOGIN, assessCapacity, requiredLogins } from './src/capacity.js';

const USAGE = `
MeetStream - Google signed-in bot admin

  Domains (/google-login-domains)
    node index.js domains list
    node index.js domains get <domain>
    node index.js domains add --user-id <id> --name <label> [--login-mode always|if_required]
    node index.js domains update <domain> --set name=NewLabel [--set login_mode=if_required]
    node index.js domains update <domain> --payload patch.json
    node index.js domains delete <domain> [--yes]

  Logins (/google-logins)
    node index.js logins list [--domain <domain>]
    node index.js logins add --payload body.json
    node index.js logins add --field email=bot@acme.com --file cert=./cert.pem --file key=./key.pem
    node index.js logins update <login_id> --set is_active=false
    node index.js logins delete <login_id> [--yes]

  Capacity planning
    node index.js capacity --peak 100 [--per-login 20] [--headroom 0.2] [--domain <domain>]

  Global flags
    --json       print raw JSON instead of tables
    --yes        skip the delete confirmation prompt

Note: POST /google-logins and the PATCH endpoints have no request body published in
the public API reference, so this CLI sends exactly what you give it rather than
guessing field names. Uploading cert.pem / key.pem per mail ID is done in the
dashboard: Integrations -> Google Signed-In Bots.
`;

function out(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
    return true;
  }
  return false;
}

async function loadPayload(file) {
  const text = await readFile(file, 'utf8');
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('payload must be a JSON object');
    }
    return parsed;
  } catch (cause) {
    throw new ConfigError(`Could not read ${file} as a JSON object: ${cause.message}`);
  }
}

async function confirm(question, skip) {
  if (skip) return true;
  if (!process.stdin.isTTY) {
    throw new ConfigError('Refusing to delete without confirmation. Re-run with --yes.');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

function printDomains(domains) {
  if (domains.length === 0) {
    console.log('No domains configured.');
    return;
  }
  console.log(`${domains.length} domain(s):\n`);
  for (const d of domains) {
    console.log(`  ${d.sso_workspace_domain ?? '(unknown)'}`);
    console.log(`    name                      ${d.name ?? '-'}`);
    console.log(`    login_mode                ${d.login_mode ?? '-'}`);
    console.log(`    logins                    ${d.login_count ?? '?'} (active ${d.active_login_count ?? '?'})`);
    console.log(`    max_concurrent_per_login  ${d.max_concurrent_per_login ?? '?'}`);
    console.log(`    created_at                ${d.created_at ?? '-'}\n`);
  }
}

function printLogins(logins) {
  if (logins.length === 0) {
    console.log('No logins configured.');
    return;
  }
  console.log(`${logins.length} login(s):\n`);
  for (const l of logins) {
    console.log(`  ${l.email ?? '(no email)'}`);
    console.log(`    login_id         ${l.login_id ?? '-'}`);
    console.log(`    is_active        ${l.is_active}`);
    console.log(`    active_sessions  ${l.active_sessions ?? 0}`);
    console.log(`    last_test        ${l.last_test_status ?? '-'} (${l.last_tested_at ?? 'never'})`);
    if (l.created_at) console.log(`    created_at       ${l.created_at}`);
    console.log('');
  }
}

async function handleDomains(client, args) {
  const [, action, target] = args.positional;
  const asJson = Boolean(args.flags.json);

  switch (action) {
    case undefined:
    case 'list': {
      const domains = await listDomains(client);
      if (!out(domains, asJson)) printDomains(domains);
      return;
    }

    case 'get': {
      if (!target) throw new ConfigError('Usage: domains get <domain>');
      const domain = await getDomain(client, target);
      if (!out(domain, asJson)) {
        printDomains([domain]);
        printLogins(Array.isArray(domain.logins) ? domain.logins : []);
      }
      return;
    }

    case 'add': {
      const { domain, replayed } = await createDomain(client, {
        userId: args.flags.userId,
        name: args.flags.name,
        loginMode: args.flags.loginMode,
      });
      if (!out(domain, asJson)) {
        console.log(replayed ? 'Already existed (507 replay).' : 'Domain created.');
        printDomains([domain]);
      }
      return;
    }

    case 'update': {
      if (!target) throw new ConfigError('Usage: domains update <domain> --set key=value');
      const patch = {
        ...(args.flags.payload ? await loadPayload(args.flags.payload) : {}),
        ...pairsToObject(args.set),
      };
      const result = await updateDomain(client, target, patch);
      if (!out(result, asJson)) {
        console.log(`Sent PATCH ${JSON.stringify(patch)}`);
        console.log(JSON.stringify(result, null, 2));
      }
      return;
    }

    case 'delete': {
      if (!target) throw new ConfigError('Usage: domains delete <domain>');
      const ok = await confirm(
        `Delete domain "${target}" and its signed-in bot configuration?`,
        Boolean(args.flags.yes)
      );
      if (!ok) {
        console.log('Aborted.');
        return;
      }
      const result = await deleteDomain(client, target);
      if (!out(result, asJson)) console.log(`Deleted domain "${target}".`);
      return;
    }

    default:
      throw new ConfigError(`Unknown domains action "${action}".`);
  }
}

async function handleLogins(client, args) {
  const [, action, target] = args.positional;
  const asJson = Boolean(args.flags.json);

  switch (action) {
    case undefined:
    case 'list': {
      if (args.flags.domain && args.flags.domain !== true) {
        const { logins } = await listLoginsForDomain(client, args.flags.domain);
        if (!out(logins, asJson)) {
          console.log(`Logins under ${args.flags.domain}:\n`);
          printLogins(logins);
        }
        return;
      }
      const logins = await listLogins(client);
      if (!out(logins, asJson)) printLogins(logins);
      return;
    }

    case 'add': {
      const json = args.flags.payload ? await loadPayload(args.flags.payload) : undefined;
      const fields = pairsToObject(args.field, { coerceValues: false });
      const files = pairsToObject(args.file, { coerceValues: false });
      const { login, replayed } = await createLogin(client, { json, fields, files });
      if (!out(login, asJson)) {
        console.log(replayed ? 'Already existed (507 replay).' : 'Login created.');
        printLogins([login]);
        console.log(
          'If this login was created without its certificate, finish it in the dashboard:\n' +
            '  Integrations -> Google Signed-In Bots -> upload cert.pem and key.pem for this mail ID.'
        );
      }
      return;
    }

    case 'update': {
      if (!target) throw new ConfigError('Usage: logins update <login_id> --set key=value');
      const patch = {
        ...(args.flags.payload ? await loadPayload(args.flags.payload) : {}),
        ...pairsToObject(args.set),
      };
      const result = await updateLogin(client, target, patch);
      if (!out(result, asJson)) {
        console.log(`Sent PATCH ${JSON.stringify(patch)}`);
        console.log(JSON.stringify(result, null, 2));
      }
      return;
    }

    case 'delete': {
      if (!target) throw new ConfigError('Usage: logins delete <login_id>');
      const ok = await confirm(`Delete login "${target}"?`, Boolean(args.flags.yes));
      if (!ok) {
        console.log('Aborted.');
        return;
      }
      const result = await deleteLogin(client, target);
      if (!out(result, asJson)) {
        console.log(result?.message ?? `Deleted login "${target}".`);
      }
      return;
    }

    default:
      throw new ConfigError(`Unknown logins action "${action}".`);
  }
}

async function handleCapacity(client, args) {
  const asJson = Boolean(args.flags.json);

  const peakRaw = args.flags.peak ?? intEnv('PEAK_CONCURRENT_MEET_SESSIONS');
  if (peakRaw === undefined || peakRaw === true) {
    throw new ConfigError(
      'Usage: node index.js capacity --peak <peak concurrent Google Meet sessions>'
    );
  }
  const peak = Number(coerce(String(peakRaw)));
  const perLogin = args.flags.perLogin ? Number(args.flags.perLogin) : SESSIONS_PER_LOGIN;
  const headroom = args.flags.headroom ? Number(args.flags.headroom) : 0;

  const logins =
    args.flags.domain && args.flags.domain !== true
      ? (await listLoginsForDomain(client, args.flags.domain)).logins
      : await listLogins(client);

  const report = assessCapacity(logins, peak, { perLogin, headroom });
  if (out(report, asJson)) return;

  console.log(`
Signed-in login capacity
========================

  Rule of thumb:  logins = peak concurrent Google Meet sessions / ${report.perLogin}

  Peak concurrent sessions   ${report.peakConcurrentSessions}
  Sessions per login         ${report.perLogin}
  Headroom                   ${Math.round(report.headroom * 100)}%
  ---------------------------------------------
  Minimum logins             ${report.minimumLogins}
  Recommended logins         ${report.recommendedLogins}  (capacity ${report.capacityAtRecommended} sessions)

  Configured logins          ${report.configuredLogins}
  Active logins              ${report.activeLogins}  (capacity ${report.currentCapacity} sessions)
  Sessions in use right now  ${report.sessionsInUseRightNow}
`);

  if (report.sufficient) {
    console.log('  OK - you have enough active logins for that peak.\n');
  } else {
    console.log(
      `  SHORT by ${report.shortfall} login(s). Add mail IDs under the domain in the dashboard\n` +
        '  (Integrations -> Google Signed-In Bots) and upload cert.pem + key.pem for each.\n'
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional[0];

  if (!command || command === 'help' || args.flags.help) {
    console.log(USAGE);
    return;
  }

  if (command === 'plan') {
    // Offline capacity math, no API key required.
    const peak = Number(args.flags.peak);
    const perLogin = args.flags.perLogin ? Number(args.flags.perLogin) : SESSIONS_PER_LOGIN;
    const headroom = args.flags.headroom ? Number(args.flags.headroom) : 0;
    console.log(JSON.stringify(requiredLogins(peak, { perLogin, headroom }), null, 2));
    return;
  }

  const client = createClient();

  switch (command) {
    case 'domains':
      await handleDomains(client, args);
      break;
    case 'logins':
      await handleLogins(client, args);
      break;
    case 'capacity':
      await handleCapacity(client, args);
      break;
    default:
      console.error(`Unknown command "${command}".`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  if (error instanceof ConfigError) {
    console.error(`\nConfiguration error: ${error.message}`);
  } else if (error instanceof MeetStreamError) {
    console.error(`\n${error.message}`);
    if (error.status === 401) console.error('MEETSTREAM_API_KEY is missing or malformed.');
    if (error.status === 403) console.error('That API key is not valid for this workspace.');
    if (error.status === 404) console.error('No such domain or login on this API key.');
  } else {
    console.error(`\n${error.stack ?? error.message}`);
  }
  process.exitCode = 1;
});
