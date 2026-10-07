/**
 * /teams-logins - the Microsoft 365 bot accounts registered under a domain.
 *
 *   POST   /teams-logins                  add       { domain, email, password, is_active? }
 *   GET    /teams-logins?domain=<d>       list      { logins: [...] }   (domain is REQUIRED)
 *   GET    /teams-logins/{login_id}       read one
 *   PATCH  /teams-logins/{login_id}       update    { password?, is_active? }
 *   DELETE /teams-logins/{login_id}       delete
 *
 * Login object:
 *   { login_id, domain, email, is_active, lease_status, last_session_result,
 *     last_login_error, created_at, updated_at }
 *
 * The password is write-only: it is never returned by the API, and this module
 * never prints it (the client redacts it from dry-run output and errors).
 *
 * Setting a new password on a deactivated login reactivates it.
 *
 * Concurrency: each login runs exactly ONE bot at a time. `lease_status` is
 * "available" when the account is free to take a new bot.
 */

import { assertDomain } from './domains.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function assertEmail(email) {
  if (!email || !EMAIL_PATTERN.test(email)) {
    throw new Error(`"${email ?? ''}" is not a valid email address.`);
  }
  return email.toLowerCase();
}

export function emailDomain(email) {
  return assertEmail(email).split('@').pop();
}

export async function createLogin(client, { domain, email, password, isActive }) {
  if (typeof password !== 'string' || password === '') {
    throw new Error(`No password for ${email}.`);
  }
  const body = { domain: assertDomain(domain), email: assertEmail(email), password };
  if (typeof isActive === 'boolean') body.is_active = isActive;

  const { data, replayed, dryRun } = await client.request('/teams-logins', {
    method: 'POST',
    body,
  });
  return { login: data, replayed, dryRun };
}

/** Every login under one domain. 404 means the domain is not registered. */
export async function listLogins(client, domain) {
  const { data } = await client.request('/teams-logins', {
    query: { domain: assertDomain(domain) },
  });
  return Array.isArray(data?.logins) ? data.logins : [];
}

export async function getLogin(client, loginId) {
  const { data } = await client.request(`/teams-logins/${encodeURIComponent(loginId)}`);
  return data;
}

export async function updateLogin(client, loginId, { password, isActive } = {}) {
  if (!loginId) throw new Error('A login_id is required.');
  const patch = {};
  if (password !== undefined) {
    if (typeof password !== 'string' || password === '') throw new Error('Empty password.');
    patch.password = password;
  }
  if (typeof isActive === 'boolean') patch.is_active = isActive;
  if (Object.keys(patch).length === 0) throw new Error('Nothing to update.');

  const { data, dryRun } = await client.request(`/teams-logins/${encodeURIComponent(loginId)}`, {
    method: 'PATCH',
    body: patch,
  });
  return { result: data, dryRun };
}

export async function deleteLogin(client, loginId) {
  if (!loginId) throw new Error('A login_id is required.');
  const { data } = await client.request(`/teams-logins/${encodeURIComponent(loginId)}`, {
    method: 'DELETE',
  });
  return data ?? {};
}

/**
 * Accept either a login_id or an email and return the login it names.
 *
 * For an email, the domain comes from `domain` if given, otherwise from the
 * email itself, and the login is found with GET /teams-logins?domain=.
 * In dry-run mode the lookup is printed and a placeholder id is returned.
 */
export async function resolveLogin(client, target, { domain } = {}) {
  if (!target) throw new Error('Name a login: an email address or a login_id.');

  if (!target.includes('@')) {
    if (client.dryRun) return { login_id: target, email: null };
    return getLogin(client, target);
  }

  const email = assertEmail(target);
  const lookupDomain = domain ? assertDomain(domain) : emailDomain(email);
  const logins = await listLogins(client, lookupDomain);

  if (client.dryRun) return { login_id: `<login_id of ${email}>`, email, domain: lookupDomain };

  const match = logins.find((l) => l.email?.toLowerCase() === email);
  if (!match) {
    const err = new Error(
      `${email} is not registered under ${lookupDomain}. ` +
        'Run "node index.js status" to see the registered accounts' +
        (domain ? '.' : ', or pass --domain if it lives under a different login domain.')
    );
    err.notFound = true;
    throw err;
  }
  return match;
}
