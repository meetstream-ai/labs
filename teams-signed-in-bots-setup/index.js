#!/usr/bin/env node
/**
 * MeetStream Labs - Microsoft Teams signed-in bots, end to end.
 *
 *   node index.js checklist        Microsoft 365 tenant prerequisites
 *   node index.js setup            register-domain + add-accounts + status (+ create-bot)
 *   node index.js register-domain  POST /teams-login-domains  (login_mode "always")
 *   node index.js add-accounts     POST /teams-logins, one per TEAMS_BOT_ACCOUNTS entry
 *   node index.js status           domains, accounts and lease status
 *   node index.js verify           read-only pre-flight before you send a real bot
 *   node index.js create-bot       create_bot with teams.login_required
 *
 * Add --dry-run to anything to print the requests (passwords redacted) instead
 * of sending them. Run `node index.js` with no arguments for the full checklist.
 */

import 'dotenv/config';
import process from 'node:process';

import {
  ConfigError,
  MeetStreamError,
  boolEnv,
  createClient,
  intEnv,
  optionalEnv,
} from './src/client.js';
import { parseArgs, stringFlag, typedConfirm } from './src/cli.js';
import { CHECKLIST, STEPS } from './src/checklist.js';
import { hintsFor } from './src/errors.js';
import {
  deleteDomain,
  getDomain,
  listDomains,
  registerDomain,
  updateDomain,
} from './src/domains.js';
import {
  createLogin,
  deleteLogin,
  emailDomain,
  listLogins,
  resolveLogin,
  updateLogin,
} from './src/logins.js';
import { collectAccounts, newPassword } from './src/accounts.js';
import { buildSignedInBotBody, createSignedInBot } from './src/bot.js';

const USAGE = `
MeetStream - Microsoft Teams signed-in bots
===========================================

A signed-in Teams bot logs into a real Microsoft 365 account before joining, so
it shows up under that account's name and picture instead of as a guest.

Setup
  node index.js checklist                      Microsoft 365 prerequisites
  node index.js setup                          steps 1-3 below, plus create-bot if MEETING_LINK is set
  node index.js register-domain [--domain d] [--name label]
  node index.js add-accounts [--domain d]      reads TEAMS_BOT_ACCOUNTS + TEAMS_BOT_PASSWORD_<n>

Inspect
  node index.js status [--domain d] [--json]   domains, accounts, lease status
  node index.js verify                         pre-flight TEAMS_LOGIN_DOMAIN / SIGN_IN_EMAIL

Manage accounts (<login> is an email or a login_id)
  node index.js rotate-password <login>        new password from TEAMS_NEW_PASSWORD or a hidden prompt
  node index.js enable <login>
  node index.js disable <login>
  node index.js remove-account <login> [--force]
  node index.js rename-domain <domain> --name <label>
  node index.js remove-domain <domain> [--force]   deletes the domain AND every account under it

Send a bot
  node index.js create-bot                     MEETING_LINK + TEAMS_LOGIN_DOMAIN [+ SIGN_IN_EMAIL]

Global flags
  --dry-run    print each request (passwords redacted) and send nothing; no API key needed
  --json       raw JSON output for status
  --force      skip the typed confirmation on removals
  --domain d   login domain (defaults to TEAMS_LOGIN_DOMAIN)

Passwords are never accepted as flags (shell history) and never printed.
`;

// ── helpers ──────────────────────────────────────────────────────────────────

function loginDomain(args, { required = true } = {}) {
  const domain = stringFlag(args.flags, 'domain') ?? optionalEnv('TEAMS_LOGIN_DOMAIN');
  if (!domain && required) {
    throw new ConfigError(
      'No login domain. Set TEAMS_LOGIN_DOMAIN in .env or pass --domain (for example bots.acme.com).'
    );
  }
  return domain?.toLowerCase();
}

function printLogin(login, indent = '    ') {
  console.log(`${indent}${login.email ?? '(no email)'}`);
  console.log(`${indent}  login_id             ${login.login_id ?? '-'}`);
  console.log(`${indent}  is_active            ${login.is_active}`);
  console.log(`${indent}  lease_status         ${login.lease_status ?? '-'}`);
  console.log(`${indent}  last_session_result  ${login.last_session_result ?? '-'}`);
  if (login.last_login_error) {
    console.log(`${indent}  last_login_error     ${login.last_login_error}`);
  }
}

function summarizeCapacity(logins) {
  const active = logins.filter((l) => l.is_active !== false);
  const free = active.filter((l) => l.lease_status === 'available');
  return { total: logins.length, active: active.length, free: free.length };
}

function printCapacity({ total, active, free }, indent = '  ') {
  console.log(
    `${indent}${total} account(s), ${active} active = up to ${active} concurrent signed-in bot(s). ` +
      `Free right now: ${free}.`
  );
}

function logMeetStreamError(error) {
  console.error(`  ${error.message}`);
  for (const line of hintsFor(error)) console.error(`  ${line}`);
}

// ── commands ─────────────────────────────────────────────────────────────────

async function cmdRegisterDomain(client, args) {
  const domain = loginDomain(args);
  const name = stringFlag(args.flags, 'name') ?? optionalEnv('TEAMS_DOMAIN_NAME');

  const existing = client.dryRun ? null : await getDomain(client, domain);
  if (existing) {
    console.log(`Domain "${domain}" is already registered on this API key (login_mode=${existing.login_mode ?? '-'}).`);
    return;
  }

  const result = await registerDomain(client, { domain, name });
  if (result.dryRun) return;
  console.log(result.replayed ? 'Domain already registered (507 replay).' : 'Domain registered.');
  console.log(JSON.stringify(result.domain, null, 2));
  console.log('\nNext: node index.js add-accounts');
}

async function cmdAddAccounts(client, args) {
  const domain = loginDomain(args);
  // Collect (and prompt for) every password before the first API call.
  const accounts = await collectAccounts({ dryRun: client.dryRun });

  for (const { email } of accounts) {
    if (emailDomain(email) !== domain) {
      console.warn(
        `WARN  ${email} is not on ${domain}. Accounts are registered under the login domain, ` +
          'and sign_in_email must belong to it.'
      );
    }
  }

  const existing = await listLogins(client, domain);
  const known = new Map(existing.map((l) => [l.email?.toLowerCase(), l]));

  let added = 0;
  let failed = 0;
  for (const account of accounts) {
    const already = known.get(account.email);
    if (already) {
      console.log(
        `skip  ${account.email} is already registered (login_id=${already.login_id}). ` +
          'To change its password: node index.js rotate-password ' +
          account.email
      );
      continue;
    }
    try {
      const { login, replayed, dryRun } = await createLogin(client, {
        domain,
        email: account.email,
        password: account.password,
      });
      if (dryRun) {
        console.log(`          (password from ${account.passwordSource})`);
        continue;
      }
      added += 1;
      console.log(
        `${replayed ? 'ok    (507 replay)' : 'added'} ${account.email}  login_id=${login?.login_id ?? '-'}  ` +
          `lease_status=${login?.lease_status ?? '-'}  (password from ${account.passwordSource})`
      );
    } catch (error) {
      if (!(error instanceof MeetStreamError)) throw error;
      failed += 1;
      console.error(`FAIL  ${account.email}`);
      logMeetStreamError(error);
      if (error.status === 401 || error.status === 403) break;
    }
  }

  if (client.dryRun) return;
  console.log(`\n${added} added, ${accounts.length - added - failed} skipped, ${failed} failed.`);
  console.log(
    'Remember: one account runs one bot at a time. Check leases with: node index.js status'
  );
  if (failed > 0) process.exitCode = 1;
}

async function cmdStatus(client, args) {
  const asJson = Boolean(args.flags.json);
  const only = loginDomain(args, { required: false });
  const onlyFlag = stringFlag(args.flags, 'domain');

  let domains;
  if (onlyFlag) {
    const record = await getDomain(client, only);
    if (!record && !client.dryRun) {
      console.log(`"${only}" is not registered on this API key. Run: node index.js register-domain`);
      process.exitCode = 1;
      return;
    }
    domains = [record ?? { domain: only }];
  } else {
    domains = await listDomains(client);
    // In dry-run nothing comes back, so show the per-domain call for TEAMS_LOGIN_DOMAIN.
    if (client.dryRun && only) domains = [{ domain: only }];
  }

  const report = [];
  for (const d of domains) {
    const logins = await listLogins(client, d.domain);
    report.push({ ...d, logins });
  }
  if (client.dryRun) return;

  if (asJson) {
    console.log(JSON.stringify({ domains: report }, null, 2));
    return;
  }
  if (report.length === 0) {
    console.log('No Teams login domains registered yet. Run: node index.js register-domain');
    return;
  }

  for (const d of report) {
    console.log(`\n${d.domain}`);
    console.log(`  name        ${d.name ?? '-'}`);
    console.log(`  login_mode  ${d.login_mode ?? '-'}`);
    console.log(`  created_at  ${d.created_at ?? '-'}`);
    printCapacity(summarizeCapacity(d.logins));
    if (d.logins.length === 0) {
      console.log('  No accounts yet. Run: node index.js add-accounts');
    }
    for (const login of d.logins) printLogin(login);
    const inactive = d.logins.filter((l) => l.is_active === false);
    if (inactive.length > 0) {
      console.log(
        `  ${inactive.length} inactive account(s). If last_login_error points at the password, fix it in\n` +
          '  Microsoft 365 and run "node index.js rotate-password <email>" (that also reactivates it).'
      );
    }
  }
}

async function cmdVerify(client, args) {
  const domain = loginDomain(args);
  const signInEmail = optionalEnv('SIGN_IN_EMAIL')?.toLowerCase();
  const strict = optionalEnv('STRICT_EMAIL') === undefined ? true : boolEnv('STRICT_EMAIL');

  let logins;
  try {
    logins = await listLogins(client, domain);
  } catch (error) {
    if (error instanceof MeetStreamError && error.status === 404) {
      console.error(
        `FAIL  "${domain}" is not registered on this API key. create_bot would return 400.\n` +
          '      Run: node index.js register-domain'
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  if (client.dryRun) return;

  console.log(`OK    domain "${domain}" is registered.`);
  const cap = summarizeCapacity(logins);
  printCapacity(cap, '      ');
  for (const login of logins) printLogin(login, '      ');

  if (cap.total === 0) {
    console.error('FAIL  no accounts under this domain. Run: node index.js add-accounts');
    process.exitCode = 1;
    return;
  }
  if (cap.active === 0) {
    console.error('FAIL  every account is inactive; create_bot would return 409.');
    process.exitCode = 1;
    return;
  }

  if (signInEmail) {
    const match = logins.find((l) => l.email?.toLowerCase() === signInEmail);
    if (!match) {
      console.error(
        `FAIL  SIGN_IN_EMAIL "${signInEmail}" is not registered under ${domain}; create_bot would return 404.`
      );
      process.exitCode = 1;
      return;
    }
    const usable = match.is_active !== false && match.lease_status === 'available';
    if (usable) {
      console.log(`OK    SIGN_IN_EMAIL "${signInEmail}" is active and free.`);
    } else if (strict) {
      console.error(
        `WARN  SIGN_IN_EMAIL "${signInEmail}" is ${match.is_active === false ? 'inactive' : `busy (lease_status=${match.lease_status})`}` +
          ' and strict_email is true, so create_bot would return 409 right now.\n' +
          '      Set STRICT_EMAIL=false to fall back to any free account.'
      );
      process.exitCode = 1;
      return;
    } else {
      console.log(
        `OK    SIGN_IN_EMAIL "${signInEmail}" is not free, but STRICT_EMAIL=false so another account will be used.`
      );
    }
  }

  if (cap.free === 0) {
    console.error('WARN  no account is free right now; create_bot would return 409 or 429 until one is.');
    process.exitCode = 1;
  }
}

async function cmdSetActive(client, args, isActive) {
  const target = args.positional[1];
  const login = await resolveLogin(client, target, { domain: stringFlag(args.flags, 'domain') });
  const { result, dryRun } = await updateLogin(client, login.login_id, { isActive });
  if (dryRun) return;
  const updated = result?.login ?? {};
  console.log(
    `${isActive ? 'Enabled' : 'Disabled'} ${updated.email ?? login.email ?? login.login_id}  ` +
      `is_active=${updated.is_active ?? isActive}  lease_status=${updated.lease_status ?? '-'}`
  );
  if (!isActive) {
    console.log('MeetStream will not assign new bots to this account until you enable it again.');
  }
}

async function cmdRotatePassword(client, args) {
  const target = args.positional[1];
  const login = await resolveLogin(client, target, { domain: stringFlag(args.flags, 'domain') });
  const { password, source } = await newPassword(login.email ?? target, { dryRun: client.dryRun });

  const { result, dryRun } = await updateLogin(client, login.login_id, { password });
  if (dryRun) {
    console.log(`          (password from ${source})`);
    return;
  }
  const updated = result?.login ?? {};
  console.log(
    `Password updated for ${updated.email ?? login.email ?? login.login_id} (from ${source}). ` +
      `is_active=${updated.is_active ?? '-'}`
  );
  console.log(
    'This only updates the copy MeetStream signs in with. Change it in Microsoft 365 first, then\n' +
      'run this straight away: bots started in between will fail to sign in.'
  );
}

async function cmdRemoveAccount(client, args) {
  const target = args.positional[1];
  const login = await resolveLogin(client, target, { domain: stringFlag(args.flags, 'domain') });

  if (!client.dryRun) {
    console.log('About to delete this Teams bot account from MeetStream:');
    printLogin(login, '  ');
    if (login.lease_status && login.lease_status !== 'available') {
      console.log(`  Note: lease_status is "${login.lease_status}"; it may be in a meeting right now.`);
    }
    const expected = login.email ?? login.login_id;
    if (!args.flags.force) {
      const ok = await typedConfirm(expected, { what: login.email ? 'email' : 'login_id' });
      if (!ok) {
        console.log('\nNot confirmed. Nothing was deleted.');
        process.exitCode = 1;
        return;
      }
    } else {
      console.log('--force given, skipping the confirmation prompt.');
    }
  }

  if (client.dryRun) console.log('(dry-run: the typed confirmation prompt would run here)');
  const result = await deleteLogin(client, login.login_id);
  if (client.dryRun) return;
  console.log(result?.message ?? 'Login deleted.');
  console.log('The Microsoft 365 user still exists; remove or unlicense it in Microsoft if you no longer need it.');
}

async function cmdRemoveDomain(client, args) {
  const target = (args.positional[1] ?? '').toLowerCase();
  if (!target) throw new ConfigError('Usage: node index.js remove-domain <domain> [--force]');

  if (!client.dryRun) {
    const record = await getDomain(client, target);
    if (!record) {
      console.error(`"${target}" is not registered on this API key. Nothing to delete.`);
      process.exitCode = 1;
      return;
    }
    const logins = Array.isArray(record.logins) ? record.logins : [];
    console.log(`About to delete domain "${target}" AND its ${logins.length} account(s):`);
    for (const l of logins) console.log(`  ${l.email}  lease_status=${l.lease_status ?? '-'}`);
    console.log('Signed-in Teams bots for this domain will stop working (create_bot returns 400).');
    if (!args.flags.force) {
      const ok = await typedConfirm(target, { what: 'domain' });
      if (!ok) {
        console.log('\nNot confirmed. Nothing was deleted.');
        process.exitCode = 1;
        return;
      }
    } else {
      console.log('--force given, skipping the confirmation prompt.');
    }
  }

  if (client.dryRun) {
    console.log('(dry-run: the account list and typed confirmation prompt would run here)');
  }
  const result = await deleteDomain(client, target);
  if (client.dryRun) return;
  console.log(result?.message ?? `Deleted domain "${target}".`);
}

async function cmdRenameDomain(client, args) {
  const target = args.positional[1];
  const name = stringFlag(args.flags, 'name');
  if (!target || !name) {
    throw new ConfigError('Usage: node index.js rename-domain <domain> --name <label>');
  }
  const { result } = await updateDomain(client, target, { name });
  if (client.dryRun) return;
  console.log(JSON.stringify(result, null, 2));
}

async function cmdCreateBot(client, args) {
  const meetingLink = optionalEnv('MEETING_LINK');
  const teamsLoginDomain = loginDomain(args, { required: false });
  if (!meetingLink || !teamsLoginDomain) {
    throw new ConfigError('create-bot needs MEETING_LINK and TEAMS_LOGIN_DOMAIN in your .env.');
  }

  const strictRaw = optionalEnv('STRICT_EMAIL');
  const opts = {
    meetingLink,
    teamsLoginDomain,
    signInEmail: optionalEnv('SIGN_IN_EMAIL'),
    strictEmail: strictRaw === undefined ? undefined : boolEnv('STRICT_EMAIL'),
    botName: optionalEnv('BOT_NAME'),
    videoRequired: boolEnv('VIDEO_REQUIRED', false),
    waitingRoomTimeout: intEnv('WAITING_ROOM_TIMEOUT', { min: 60, max: 1800 }),
    callbackUrl: optionalEnv('CALLBACK_URL'),
  };

  if (optionalEnv('BOT_IMAGE_URL')) {
    console.warn(
      'WARN  BOT_IMAGE_URL is ignored: a signed-in Teams bot shows the Microsoft account\'s own picture.'
    );
  }
  console.log(
    'Note: the bot appears under the Microsoft account\'s display name and picture. bot_name and\n' +
      'bot_image_url are not applied to signed-in Teams bots.\n'
  );

  if (!client.dryRun) {
    // Printed before sending so error hints can refer to it.
    console.log('Request:');
    console.log(JSON.stringify(buildSignedInBotBody(opts).body, null, 2));
  }

  const { bot, replayed, dryRun, warnings } = await createSignedInBot(client, opts);
  for (const w of warnings) console.warn(`WARN  ${w}`);
  if (dryRun) return;

  console.log(replayed ? '\nIdempotent replay (507) - the bot already exists.' : '\nBot created.');
  console.log(JSON.stringify(bot, null, 2));
  console.log(
    '\nThat account is now leased to this bot until it leaves; it cannot run a second bot meanwhile.' +
      '\nWatch progress with GET /bots/{bot_id}/status. If the bot shows up as a guest under' +
      '\nbot_name, the teams block was not applied: compare it with the request above.'
  );
}

async function cmdSetup(client, args) {
  console.log(CHECKLIST);
  console.log('Running the MeetStream side...\n');

  console.log('== 1. Register the login domain');
  await cmdRegisterDomain(client, args);

  console.log('\n== 2. Register the bot accounts');
  await cmdAddAccounts(client, args);
  if (process.exitCode) return;

  console.log('\n== 3. Accounts and lease status');
  await cmdStatus(client, { ...args, flags: { ...args.flags, domain: loginDomain(args) } });

  if (optionalEnv('MEETING_LINK')) {
    console.log('\n== 4. Send a signed-in bot');
    await cmdCreateBot(client, args);
  } else {
    console.log('\nSet MEETING_LINK and run "node index.js create-bot" to send a signed-in bot.');
  }
}

// ── router ───────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional[0];

  if (!command || command === 'help' || args.flags.help) {
    console.log(USAGE);
    if (!command) console.log(CHECKLIST + STEPS);
    return;
  }
  if (command === 'checklist') {
    console.log(CHECKLIST + STEPS);
    return;
  }

  const dryRun = Boolean(args.flags.dryRun);
  const client = createClient({ dryRun });
  if (dryRun) console.log('DRY RUN - nothing is sent to the API. Passwords are redacted.\n');

  const needsTarget = ['rotate-password', 'enable', 'disable', 'remove-account'];
  if (needsTarget.includes(command) && !args.positional[1]) {
    throw new ConfigError(`Usage: node index.js ${command} <email or login_id>`);
  }

  switch (command) {
    case 'setup':
      await cmdSetup(client, args);
      break;
    case 'register-domain':
      await cmdRegisterDomain(client, args);
      break;
    case 'add-accounts':
      await cmdAddAccounts(client, args);
      break;
    case 'status':
      await cmdStatus(client, args);
      break;
    case 'verify':
      await cmdVerify(client, args);
      break;
    case 'rotate-password':
      await cmdRotatePassword(client, args);
      break;
    case 'enable':
      await cmdSetActive(client, args, true);
      break;
    case 'disable':
      await cmdSetActive(client, args, false);
      break;
    case 'remove-account':
      await cmdRemoveAccount(client, args);
      break;
    case 'remove-domain':
      await cmdRemoveDomain(client, args);
      break;
    case 'rename-domain':
      await cmdRenameDomain(client, args);
      break;
    case 'create-bot':
      await cmdCreateBot(client, args);
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
    console.error('');
    logMeetStreamError(error);
  } else if (process.env.DEBUG) {
    console.error(`\n${error.stack ?? error.message}`);
  } else {
    console.error(`\n${error.message}`);
  }
  process.exitCode = 1;
});
