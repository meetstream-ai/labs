/**
 * /google-logins - the login half of the Google signed-in bot admin surface.
 *
 *   POST   /google-logins              create a login
 *   GET    /google-logins              list logins
 *   PATCH  /google-logins/{login_id}   update a login
 *   DELETE /google-logins/{login_id}   delete a login
 *
 * HONEST LIMITATION
 * -----------------
 * The public API reference documents the *responses* for all four calls but not
 * the request bodies for POST and PATCH. Creating a login also involves the SAML
 * certificate pair (cert.pem + key.pem), which the dashboard uploads per mail ID
 * under Integrations -> Google Signed-In Bots.
 *
 * So this module does not invent a schema. It gives you the transport and lets
 * you supply the exact body:
 *
 *   --payload body.json          send that JSON verbatim
 *   --field  email=bot@acme.com  build a multipart/form-data field
 *   --file   cert=./cert.pem     attach a file to a multipart/form-data field
 *
 * Confirm the field names against
 * https://docs.meetstream.ai/api-reference/api-endpoints/google-signed-in-bots/create-google-login
 * (or just use the dashboard, which is the supported path for cert upload).
 *
 * Responses are documented and stable:
 *   create -> { login_id, domain, email, is_active, created_at }
 *   list   -> { logins: [ { login_id, email, is_active, active_sessions,
 *                           last_test_status, last_tested_at, created_at } ] }
 *   update -> { success, login: { login_id, email, is_active, updated_at } }
 *   delete -> { success, message }
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

export async function listLogins(client) {
  const { data } = await client.request('/google-logins');
  return Array.isArray(data?.logins) ? data.logins : [];
}

/**
 * Logins scoped to one domain. There is no documented query filter on
 * GET /google-logins, but GET /google-login-domains/{domain} returns the
 * domain's logins inline - so that is what we use.
 */
export async function listLoginsForDomain(client, domain) {
  const { data } = await client.request(`/google-login-domains/${encodeURIComponent(domain)}`);
  return {
    domain: data,
    logins: Array.isArray(data?.logins) ? data.logins : [],
  };
}

async function fileToBlob(filePath) {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`${filePath} is not a file.`);
  const stream = Readable.toWeb(createReadStream(filePath));
  const buffer = await new Response(stream).arrayBuffer();
  return new File([buffer], path.basename(filePath));
}

/**
 * @param {object} opts
 * @param {object} [opts.json]   JSON body to send verbatim
 * @param {object} [opts.fields] multipart text fields
 * @param {object} [opts.files]  multipart file fields, { fieldName: filePath }
 */
export async function createLogin(client, { json, fields, files } = {}) {
  const hasMultipart =
    (fields && Object.keys(fields).length > 0) || (files && Object.keys(files).length > 0);

  if (json && hasMultipart) {
    throw new Error('Use either --payload (JSON) or --field/--file (multipart), not both.');
  }
  if (!json && !hasMultipart) {
    throw new Error(
      'Nothing to send. POST /google-logins has no published request body, so supply it ' +
        'yourself with --payload body.json, or --field key=value --file cert=./cert.pem. ' +
        'The dashboard (Integrations -> Google Signed-In Bots) is the supported path for ' +
        'uploading cert.pem and key.pem.'
    );
  }

  if (json) {
    const { data, replayed } = await client.request('/google-logins', { method: 'POST', body: json });
    return { login: data, replayed };
  }

  const form = new FormData();
  for (const [key, value] of Object.entries(fields ?? {})) {
    form.append(key, String(value));
  }
  for (const [key, filePath] of Object.entries(files ?? {})) {
    form.append(key, await fileToBlob(filePath), path.basename(filePath));
  }

  const { data, replayed } = await client.request('/google-logins', { method: 'POST', form });
  return { login: data, replayed };
}

export async function updateLogin(client, loginId, patch) {
  if (!loginId) throw new Error('Login update requires a login_id.');
  if (!patch || Object.keys(patch).length === 0) {
    throw new Error('Nothing to update - pass --set key=value or --payload file.json.');
  }
  const { data } = await client.request(`/google-logins/${encodeURIComponent(loginId)}`, {
    method: 'PATCH',
    body: patch,
  });
  return data;
}

export async function deleteLogin(client, loginId) {
  if (!loginId) throw new Error('Login delete requires a login_id.');
  const { data } = await client.request(`/google-logins/${encodeURIComponent(loginId)}`, {
    method: 'DELETE',
  });
  return data ?? {};
}
