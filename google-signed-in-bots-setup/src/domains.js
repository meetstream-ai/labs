/**
 * Google signed-in bot domain endpoints.
 *
 *   POST   /google-login-domains            create a domain entry
 *   GET    /google-login-domains            list domain entries
 *   GET    /google-login-domains/{domain}   one domain + its logins
 *   PATCH  /google-login-domains/{domain}   update a domain
 *   DELETE /google-login-domains/{domain}   remove a domain
 *
 * Request body for the create call, per the API reference
 * (https://docs.meetstream.ai/api-reference/api-endpoints/google-signed-in-bots/create-google-domain):
 *
 *   user_id     string  required
 *   name        string  required
 *   login_mode  enum    optional - "always" | "if_required"
 *
 * The response echoes `sso_workspace_domain`, `name`, `login_mode`,
 * `max_concurrent_per_login` and `created_at`.
 */

export const LOGIN_MODES = ['always', 'if_required'];

export async function createDomain(client, { userId, name, loginMode }) {
  if (!userId) throw new Error('createDomain requires a user_id.');
  if (!name) throw new Error('createDomain requires a name.');
  if (loginMode !== undefined && !LOGIN_MODES.includes(loginMode)) {
    throw new Error(`login_mode must be one of ${LOGIN_MODES.join(' | ')}, got "${loginMode}".`);
  }

  const body = { user_id: userId, name };
  if (loginMode !== undefined) body.login_mode = loginMode;

  const { data, replayed } = await client.request('/google-login-domains', {
    method: 'POST',
    body,
  });
  return { domain: data, replayed };
}

export async function listDomains(client) {
  const { data } = await client.request('/google-login-domains');
  // Documented shape: { "domains": [ ... ] }
  return Array.isArray(data?.domains) ? data.domains : [];
}

export async function getDomain(client, domain) {
  if (!domain) throw new Error('getDomain requires a domain.');
  const { data } = await client.request(`/google-login-domains/${encodeURIComponent(domain)}`);
  return data;
}

export async function updateDomain(client, domain, patch) {
  if (!domain) throw new Error('updateDomain requires a domain.');
  if (!patch || Object.keys(patch).length === 0) {
    throw new Error('updateDomain requires at least one field to change.');
  }
  const { data } = await client.request(`/google-login-domains/${encodeURIComponent(domain)}`, {
    method: 'PATCH',
    body: patch,
  });
  return data;
}

export async function deleteDomain(client, domain) {
  if (!domain) throw new Error('deleteDomain requires a domain.');
  const { data } = await client.request(`/google-login-domains/${encodeURIComponent(domain)}`, {
    method: 'DELETE',
  });
  return data;
}

/** List every login MeetStream holds (across all domains). */
export async function listLogins(client) {
  const { data } = await client.request('/google-logins');
  return Array.isArray(data?.logins) ? data.logins : [];
}
