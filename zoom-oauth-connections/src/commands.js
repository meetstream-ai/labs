import { randomUUID } from 'node:crypto';

import {
  createConnection,
  deleteConnection,
  getAuthorizeUrl,
  getConnection,
  listConnections
} from './api.js';
import { startCallbackServer } from './callback-server.js';
import { resolveListener } from './cli.js';

/**
 * The five commands. Each one takes the API key plus the parsed CLI options and
 * prints a human-readable view, or raw JSON with --json.
 */

/** Read the redirect URI from --redirect-uri, then ZOOM_REDIRECT_URI. */
function readRedirectUri(options) {
  const value = options.flags.redirectUri || process.env.ZOOM_REDIRECT_URI?.trim();
  if (!value) {
    throw new Error(
      'No redirect URI. Set ZOOM_REDIRECT_URI in .env or pass --redirect-uri <url>. ' +
        'It must match the redirect URL registered on your Zoom app byte-for-byte.'
    );
  }
  return value;
}

/**
 * connect - the whole hosted OAuth flow in one command.
 *
 *   1. GET  /zoom/oauth/authorize-url   -> the URL the end user opens
 *   2. the end user approves in Zoom, Zoom redirects to redirect_uri with ?code=
 *   3. POST /zoom/oauth/connections     -> exchanges the code for a stored connection
 */
export async function commandConnect(apiKey, options) {
  const redirectUri = readRedirectUri(options);
  const state = options.flags.state || `labs-${randomUUID()}`;
  const listener = resolveListener(redirectUri, options.flags.port ?? process.env.PORT);
  const timeoutMs = Number(options.flags.timeout ?? 300) * 1000;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`--timeout must be a positive number of seconds.`);
  }

  // Step 1: ask MeetStream for the authorize URL.
  const { authorizeUrl } = await getAuthorizeUrl(apiKey, { redirectUri, state });

  // Step 2: catch the redirect locally.
  const server = await startCallbackServer({
    port: listener.port,
    pathname: listener.pathname,
    expectedState: state
  });

  try {
    console.log('');
    console.log(`Callback listener  http://localhost:${listener.port}${listener.pathname}`);
    console.log(`Redirect URI       ${redirectUri}`);
    if (!listener.isLocal) {
      console.log('                   (not localhost, so a tunnel must forward to the port above)');
    }
    console.log(`State              ${state}`);
    console.log('');
    console.log('Open this URL in the browser of the Zoom user who is connecting:');
    console.log('');
    console.log(`  ${authorizeUrl}`);
    console.log('');
    console.log(`Waiting up to ${Math.round(timeoutMs / 1000)}s for Zoom to call back. Ctrl+C to stop.`);

    const { code } = await server.waitForCode(timeoutMs);
    console.log('[ok] Authorization code received.');

    // Step 3: exchange it. redirect_uri must be identical to step 1.
    const { connection, replayed } = await createConnection(apiKey, {
      code,
      redirectUri,
      metadata: options.meta
    });

    if (replayed) console.log('[i]  MeetStream replayed an earlier identical exchange (HTTP 507).');

    if (options.json) {
      console.log(JSON.stringify(connection, null, 2));
      return;
    }

    console.log('');
    console.log('Connection stored.');
    printConnection(connection);
    console.log('');
    console.log('Use it on create_bot for a Zoom meeting owned by this user:');
    console.log('');
    console.log('  POST /bots/create_bot');
    console.log('  {');
    console.log('    "meeting_link": "https://zoom.us/j/...",');
    console.log('    "bot_name": "Notetaker",');
    console.log('    "zoom": {');
    console.log('      "use_zoom_obf": true,');
    console.log(`      "zoom_oauth_connection_user_id": "${connection.zoom_user_id}"`);
    console.log('    }');
    console.log('  }');
  } finally {
    await server.close();
  }
}

/**
 * authorize-url - print the URL and stop.
 *
 * Use this when your own web app already owns the redirect route: it does the
 * POST /zoom/oauth/connections exchange from its own handler, and this CLI is
 * only here to produce the link.
 */
export async function commandAuthorizeUrl(apiKey, options) {
  const redirectUri = readRedirectUri(options);
  const state = options.flags.state || `labs-${randomUUID()}`;

  const { authorizeUrl, raw } = await getAuthorizeUrl(apiKey, { redirectUri, state });

  if (options.json) {
    console.log(JSON.stringify(raw, null, 2));
    return;
  }

  console.log('');
  console.log(`Redirect URI  ${redirectUri}`);
  console.log(`State         ${state}`);
  console.log('');
  console.log(authorizeUrl);
  console.log('');
  console.log('When Zoom redirects back with ?code=..., POST it to /zoom/oauth/connections');
  console.log('with the exact same redirect_uri.');
}

/** list - every stored connection. */
export async function commandList(apiKey, options) {
  const connections = await listConnections(apiKey);

  if (options.json) {
    console.log(JSON.stringify(connections, null, 2));
    return;
  }

  if (connections.length === 0) {
    console.log('No Zoom connections stored yet. Run "node index.js connect" to add one.');
    return;
  }

  console.log(`${connections.length} Zoom connection${connections.length === 1 ? '' : 's'}:`);
  for (const connection of connections) {
    console.log('');
    printConnection(connection);
  }
}

/** get - one connection by zoom_user_id. */
export async function commandGet(apiKey, zoomUserId, options) {
  if (!zoomUserId) throw new Error('get needs a zoom_user_id. Run "node index.js list" to see them.');

  const connection = await getConnection(apiKey, zoomUserId);

  if (options.json) {
    console.log(JSON.stringify(connection, null, 2));
    return;
  }

  printConnection(connection);
}

/** delete - disconnect a Zoom user. */
export async function commandDelete(apiKey, zoomUserId, options) {
  if (!zoomUserId) throw new Error('delete needs a zoom_user_id. Run "node index.js list" to see them.');
  if (!options.flags.yes) {
    throw new Error(
      `Refusing to delete "${zoomUserId}" without --yes. The user has to go through Zoom's consent screen again.`
    );
  }

  const result = await deleteConnection(apiKey, zoomUserId);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(result?.message || `Disconnected ${zoomUserId}.`);
  console.log('Bots can no longer be created on that user\'s behalf until they re-authorize.');
}

/**
 * Print a ZoomOAuthConnection. Token material is never part of this payload:
 * the API returns identity, metadata, state, and timestamps only.
 *
 * @param {Record<string, any>} connection
 */
function printConnection(connection) {
  if (!connection || typeof connection !== 'object') {
    console.log(String(connection));
    return;
  }

  const row = (label, value) => {
    if (value === undefined || value === null || value === '') return;
    console.log(`  ${label.padEnd(18)} ${value}`);
  };

  row('zoom_user_id', connection.zoom_user_id);
  row('zoom_account_id', connection.zoom_account_id);
  row('email', connection.email);
  row('display_name', connection.display_name);
  row('state', connection.state);
  row('has_refresh_token', connection.has_refresh_token === undefined ? undefined : String(connection.has_refresh_token));
  row('created_at', connection.created_at);
  row('updated_at', connection.updated_at);

  const metadata = connection.metadata;
  if (metadata && typeof metadata === 'object' && Object.keys(metadata).length > 0) {
    console.log('  metadata');
    for (const [key, value] of Object.entries(metadata)) {
      console.log(`    ${key}: ${value}`);
    }
  }
}
