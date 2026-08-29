// Tiny argv parser. No dependency needed for five subcommands.

export const USAGE = `
zoom-oauth-connections - hosted Zoom OAuth connections for MeetStream

Usage
  node index.js <command> [options]

Commands
  connect                    Run the whole flow: authorize URL -> local callback ->
                             exchange the code for a stored connection
  authorize-url              Print the Zoom authorize URL and exit, for when your own
                             app already owns the redirect route
                             (GET  /zoom/oauth/authorize-url)
  list                       List every stored connection
                             (GET  /zoom/oauth/connections)
  get <zoom_user_id>         Show one connection
                             (GET  /zoom/oauth/connections/{zoom_user_id})
  delete <zoom_user_id>      Disconnect that Zoom user
                             (DELETE /zoom/oauth/connections/{zoom_user_id})

connect / authorize-url options
  --redirect-uri <url>  Overrides ZOOM_REDIRECT_URI. Must match the redirect URL
                        registered on your Zoom app byte-for-byte.
  --state <text>        Opaque value round-tripped back to your callback, typically
                        your own end-user id. A random value is generated if omitted.
  --meta <key=value>    Stored on the connection as metadata. Repeatable.
                        Values are always strings. (connect only)
  --port <number>       Local port the callback listener binds to. Defaults to PORT,
                        then to the port in the redirect URI, then 3000. (connect only)
  --timeout <seconds>   How long to wait for the callback. Default 300. (connect only)

delete options
  --yes                 Required. The end user has to re-authorize after this.

global options
  --json                Print raw JSON instead of the formatted view
  --help                Show this text

Examples
  node index.js connect
  node index.js connect --meta tenant_user_id=usr_1842 --meta plan=pro
  node index.js authorize-url --state usr_1842
  node index.js list
  node index.js list --json
  node index.js get abc123XYZ
  node index.js delete abc123XYZ --yes
`.trim();

const VALUE_FLAGS = new Set(['--redirect-uri', '--state', '--meta', '--port', '--timeout']);
const BOOLEAN_FLAGS = new Set(['--yes', '--json', '--help', '-h']);

export function parseArgs(argv) {
  const result = { command: '', positional: [], meta: {}, flags: {} };

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];

    // Positional: the first one is the command, the rest are arguments to it.
    if (!token.startsWith('-')) {
      if (result.command) result.positional.push(token);
      else result.command = token;
      continue;
    }

    if (BOOLEAN_FLAGS.has(token)) {
      result.flags[normalize(token)] = true;
      continue;
    }

    // Accept both "--flag value" and "--flag=value".
    const equals = token.indexOf('=');
    const name = equals > 0 ? token.slice(0, equals) : token;
    if (!VALUE_FLAGS.has(name)) throw new Error(`Unknown option ${name}. Run "node index.js --help".`);

    const value = equals > 0 ? token.slice(equals + 1) : argv[++index];
    if (value === undefined) throw new Error(`${name} needs a value.`);

    if (name === '--meta') {
      const [metaKey, ...rest] = value.split('=');
      if (!metaKey || rest.length === 0) {
        throw new Error(`--meta expects key=value, got "${value}".`);
      }
      // The API types metadata values as strings, so no JSON parsing here.
      result.meta[metaKey] = rest.join('=');
    } else {
      result.flags[normalize(name)] = value;
    }
  }

  return result;
}

function normalize(flag) {
  if (flag === '-h') return 'help';
  return flag.replace(/^--?/, '').replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

/**
 * Work out where the local callback listener should bind, given the redirect
 * URI the Zoom app has registered.
 *
 * The redirect URI is whatever Zoom will send the browser to. When it is a
 * tunnel (ngrok and friends) the tunnel forwards to a local port, which is why
 * the port is configurable independently of the URL.
 *
 * @param {string} redirectUri
 * @param {string|number} [portOverride]
 * @returns {{ url: URL, port: number, pathname: string, isLocal: boolean }}
 */
export function resolveListener(redirectUri, portOverride) {
  let url;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new Error(`ZOOM_REDIRECT_URI is not a valid URL: "${redirectUri}"`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`ZOOM_REDIRECT_URI must be an http or https URL, got "${url.protocol}".`);
  }

  const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);

  let port;
  if (portOverride !== undefined && portOverride !== '') {
    port = Number(portOverride);
  } else if (isLocal && url.port) {
    port = Number(url.port);
  } else {
    port = 3000;
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid callback port "${portOverride ?? port}".`);
  }

  return { url, port, pathname: url.pathname || '/', isLocal };
}
