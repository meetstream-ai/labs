/**
 * Public URL resolution.
 *
 * MeetStream's bot runs in the cloud and connects *inwards* to your server, so
 * your WebSocket endpoint has to be reachable from the public internet over TLS.
 *
 * Two ways to get one:
 *   1. PUBLIC_URL     : you already have a public HTTPS host (ngrok, Cloudflare
 *                        tunnel, a deployed box, whatever). Nothing is started here.
 *   2. NGROK_AUTHTOKEN: an ngrok tunnel is opened for you at startup.
 */

export async function resolvePublicUrl(port) {
  const explicit = process.env.PUBLIC_URL?.trim();

  if (explicit) {
    if (!/^https:\/\//i.test(explicit)) {
      throw new Error(
        `PUBLIC_URL must be an https:// URL (got "${explicit}"). ` +
        "MeetStream will not connect to a plain http:// or ws:// endpoint."
      );
    }
    return { url: explicit.replace(/\/+$/, ""), source: "PUBLIC_URL", close: async () => {} };
  }

  const authtoken = process.env.NGROK_AUTHTOKEN?.trim();
  if (!authtoken) {
    throw new Error(
      "No public URL available.\n" +
      "  Set PUBLIC_URL to an https:// address you already control, or\n" +
      "  set NGROK_AUTHTOKEN (free at dashboard.ngrok.com) to have a tunnel opened automatically."
    );
  }

  let ngrok;
  try {
    ngrok = (await import("@ngrok/ngrok")).default;
  } catch (err) {
    throw new Error(
      `Could not load @ngrok/ngrok (${err.message}). Run "npm install", ` +
      "or set PUBLIC_URL instead of NGROK_AUTHTOKEN."
    );
  }

  const listener = await ngrok.connect({ addr: port, authtoken });
  return {
    url: listener.url().replace(/\/+$/, ""),
    source: "ngrok",
    close: async () => {
      try {
        await ngrok.disconnect();
      } catch {
        /* best effort */
      }
    },
  };
}

/** https://abc.ngrok.io  ->  wss://abc.ngrok.io */
export function toWss(httpsUrl) {
  return httpsUrl.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
}
