/**
 * /google-login-domains - the domain half of the Google signed-in bot admin surface.
 *
 *   POST   /google-login-domains            create
 *   GET    /google-login-domains            list
 *   GET    /google-login-domains/{domain}   read one (includes its logins)
 *   PATCH  /google-login-domains/{domain}   update
 *   DELETE /google-login-domains/{domain}   delete
 *
 * Only the create call has a request body documented in the public API reference:
 *   user_id (string, required), name (string, required),
 *   login_mode (enum, optional: "always" | "if_required").
 *
 * The PATCH body is not published, so `updateDomain` sends whatever object you
 * hand it rather than guessing field names. Check
 * https://docs.meetstream.ai/api-reference/api-endpoints/google-signed-in-bots/update-google-domain
 * for the current contract; the 200 response echoes name and login_mode, which
 * are the fields the dashboard lets you change.
 */

export const LOGIN_MODES = ['always', 'if_required'];

export async function createDomain(client, { userId, name, loginMode }) {
  if (!userId) throw new Error('Domain create requires --user-id.');
  if (!name) throw new Error('Domain create requires --name.');
  if (loginMode !== undefined && !LOGIN_MODES.includes(loginMode)) {
    throw new Error(`--login-mode must be one of ${LOGIN_MODES.join(' | ')}, got "${loginMode}".`);
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
  return Array.isArray(data?.domains) ? data.domains : [];
}

export async function getDomain(client, domain) {
  const { data } = await client.request(`/google-login-domains/${encodeURIComponent(domain)}`);
  return data;
}

export async function updateDomain(client, domain, patch) {
  if (!patch || Object.keys(patch).length === 0) {
    throw new Error('Nothing to update - pass --set key=value or --payload file.json.');
  }
  const { data } = await client.request(`/google-login-domains/${encodeURIComponent(domain)}`, {
    method: 'PATCH',
    body: patch,
  });
  return data;
}

export async function deleteDomain(client, domain) {
  const { data } = await client.request(`/google-login-domains/${encodeURIComponent(domain)}`, {
    method: 'DELETE',
  });
  // Documented 200 response for this endpoint is an empty body.
  return data ?? {};
}
