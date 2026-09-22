/**
 * /teams-login-domains - the domain half of the Teams signed-in bot setup.
 *
 *   POST   /teams-login-domains            register   { domain, name?, login_mode? }
 *   GET    /teams-login-domains            list       { domains: [...] }
 *   GET    /teams-login-domains/{domain}   one domain, logins inline
 *   PATCH  /teams-login-domains/{domain}   update     { name?, login_mode? }
 *   DELETE /teams-login-domains/{domain}   delete - CASCADES to every login under it
 *
 * `domain` is the part after the @ in the bot accounts' sign-in emails, for
 * example `bots.acme.com` for `bot1@bots.acme.com`.
 *
 * login_mode: only "always" is supported for Teams today. "if_required" (sign
 * in only when the meeting needs it) is a Google Meet option and is rejected
 * here rather than sent.
 *
 * List entries look like
 *   { domain, name, login_mode, login_count, active_login_count, created_at }
 * and the single-domain read adds
 *   logins: [{ login_id, email, is_active, lease_status, last_session_result }]
 */

export const TEAMS_LOGIN_MODE = 'always';

const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

export function assertDomain(domain) {
  if (!domain) throw new Error('A Teams login domain is required (for example bots.acme.com).');
  if (domain.includes('@')) {
    throw new Error(
      `"${domain}" looks like an email. The login domain is only the part after the @, ` +
        `for example "${domain.split('@').pop()}".`
    );
  }
  if (!DOMAIN_PATTERN.test(domain)) {
    throw new Error(`"${domain}" is not a valid domain name.`);
  }
  return domain.toLowerCase();
}

function assertLoginMode(loginMode) {
  if (loginMode !== undefined && loginMode !== TEAMS_LOGIN_MODE) {
    throw new Error(
      `login_mode "${loginMode}" is not supported for Teams yet; use "${TEAMS_LOGIN_MODE}".`
    );
  }
}

export function buildDomainBody({ domain, name, loginMode = TEAMS_LOGIN_MODE }) {
  assertLoginMode(loginMode);
  const body = { domain: assertDomain(domain), login_mode: loginMode };
  if (name) body.name = name;
  return body;
}

export async function registerDomain(client, opts) {
  const body = buildDomainBody(opts);
  const { data, replayed, dryRun } = await client.request('/teams-login-domains', {
    method: 'POST',
    body,
  });
  return { domain: data, replayed, dryRun, request: body };
}

export async function listDomains(client) {
  const { data } = await client.request('/teams-login-domains');
  return Array.isArray(data?.domains) ? data.domains : [];
}

/** One domain with its logins inline, or null if it is not registered (404). */
export async function getDomain(client, domain) {
  try {
    const { data } = await client.request(
      `/teams-login-domains/${encodeURIComponent(assertDomain(domain))}`
    );
    return data;
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

export async function updateDomain(client, domain, { name, loginMode } = {}) {
  assertLoginMode(loginMode);
  const patch = {};
  if (name) patch.name = name;
  if (loginMode) patch.login_mode = loginMode;
  if (Object.keys(patch).length === 0) {
    throw new Error('Nothing to update - pass --name <label>.');
  }
  const { data } = await client.request(
    `/teams-login-domains/${encodeURIComponent(assertDomain(domain))}`,
    { method: 'PATCH', body: patch }
  );
  return { result: data, request: patch };
}

export async function deleteDomain(client, domain) {
  const { data } = await client.request(
    `/teams-login-domains/${encodeURIComponent(assertDomain(domain))}`,
    { method: 'DELETE' }
  );
  return data ?? {};
}
