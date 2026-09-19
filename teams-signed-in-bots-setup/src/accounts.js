/**
 * Where bot account passwords come from.
 *
 *   TEAMS_BOT_ACCOUNTS=bot1@bots.acme.com,bot2@bots.acme.com
 *   TEAMS_BOT_PASSWORD_1=...    password for the 1st email in the list
 *   TEAMS_BOT_PASSWORD_2=...    password for the 2nd, and so on
 *
 * Numbering is 1-based and follows the order of TEAMS_BOT_ACCOUNTS. If a
 * password variable is missing and you are at a terminal, you are prompted
 * for it with echo turned off. Passwords are never accepted as CLI flags
 * (shell history) and never printed.
 *
 * For rotate-password, the new value comes from TEAMS_NEW_PASSWORD or the
 * same hidden prompt.
 */

import { ConfigError, optionalEnv } from './client.js';
import { promptSecret } from './cli.js';
import { assertEmail } from './logins.js';

export function passwordVar(index) {
  return `TEAMS_BOT_PASSWORD_${index + 1}`;
}

/** Parse TEAMS_BOT_ACCOUNTS into a de-duplicated, validated email list. */
export function configuredEmails() {
  const raw = optionalEnv('TEAMS_BOT_ACCOUNTS');
  if (!raw) {
    throw new ConfigError(
      'TEAMS_BOT_ACCOUNTS is empty. Set it to a comma-separated list of bot account emails, ' +
        'e.g. TEAMS_BOT_ACCOUNTS=bot1@bots.acme.com,bot2@bots.acme.com, with ' +
        'TEAMS_BOT_PASSWORD_1, TEAMS_BOT_PASSWORD_2, ... alongside.'
    );
  }
  const emails = raw
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);

  const seen = new Set();
  return emails.map((email) => {
    let normalized;
    try {
      normalized = assertEmail(email);
    } catch (error) {
      throw new ConfigError(`TEAMS_BOT_ACCOUNTS: ${error.message}`);
    }
    if (seen.has(normalized)) {
      throw new ConfigError(`TEAMS_BOT_ACCOUNTS lists ${normalized} twice.`);
    }
    seen.add(normalized);
    return normalized;
  });
}

/**
 * Collect { email, password, passwordSource } for every configured account
 * BEFORE any API call, so a missing password fails the run up front instead of
 * halfway through. In dry-run mode a missing password is reported, not prompted.
 */
export async function collectAccounts({ dryRun = false } = {}) {
  const emails = configuredEmails();
  const accounts = [];

  for (const [index, email] of emails.entries()) {
    const varName = passwordVar(index);
    // Read the raw value: leading/trailing spaces can be part of a password.
    const fromEnv = process.env[varName];
    if (typeof fromEnv === 'string' && fromEnv !== '') {
      accounts.push({ email, password: fromEnv, passwordSource: varName });
      continue;
    }
    if (dryRun) {
      accounts.push({ email, password: '(prompt)', passwordSource: `${varName} not set` });
      continue;
    }
    const typed = await promptSecret(`Password for ${email} (${varName} is not set): `);
    if (typed === null) {
      throw new ConfigError(
        `${varName} is not set for ${email} and there is no terminal to prompt on. ` +
          `Add ${varName} to your .env.`
      );
    }
    if (typed === '') throw new ConfigError(`Empty password for ${email}.`);
    accounts.push({ email, password: typed, passwordSource: 'prompt' });
  }

  return accounts;
}

/** The new password for rotate-password: TEAMS_NEW_PASSWORD or a hidden prompt. */
export async function newPassword(email, { dryRun = false } = {}) {
  const fromEnv = process.env.TEAMS_NEW_PASSWORD;
  if (typeof fromEnv === 'string' && fromEnv !== '') {
    return { password: fromEnv, source: 'TEAMS_NEW_PASSWORD' };
  }
  if (dryRun) return { password: '(prompt)', source: 'prompt' };

  const label = email ?? 'this login';
  const first = await promptSecret(`New password for ${label}: `);
  if (first === null) {
    throw new ConfigError(
      'No TEAMS_NEW_PASSWORD set and no terminal to prompt on. Set TEAMS_NEW_PASSWORD for this run.'
    );
  }
  if (first === '') throw new ConfigError('Empty password.');
  const second = await promptSecret('Repeat it: ');
  if (second !== first) throw new ConfigError('The two passwords did not match. Nothing changed.');
  return { password: first, source: 'prompt' };
}
