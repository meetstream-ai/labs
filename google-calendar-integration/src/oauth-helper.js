/**
 * One-time Google OAuth helper.
 *
 * Runs a tiny local HTTP server, sends you through Google's consent screen and
 * prints the refresh token that MeetStream needs. No SDK required: this talks
 * to Google's OAuth endpoints directly with the built-in fetch.
 *
 * Run it with:  npm run oauth
 */

import "dotenv/config";
import http from "node:http";

const PORT = Number(process.env.OAUTH_PORT || 3000);
const CALLBACK_PATH = "/api/google/oauth-callback";
const REDIRECT_URI = `http://localhost:${PORT}${CALLBACK_PATH}`;

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/**
 * Read-only calendar access plus enough profile scope for MeetStream to label
 * the connection with your email address.
 */
export const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

function requireClientCredentials() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error(
      "\nGOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set before running the OAuth helper."
    );
    console.error("Copy .env.example to .env and fill in the values from");
    console.error("Google Cloud Console > APIs & Services > Credentials.\n");
    process.exit(1);
  }

  return { clientId, clientSecret };
}

function buildAuthUrl(clientId) {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  // access_type=offline is what makes Google issue a refresh token at all.
  url.searchParams.set("access_type", "offline");
  // prompt=consent forces a fresh refresh token even if you already consented.
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  return url.toString();
}

async function exchangeCodeForTokens(code, clientId, clientSecret) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { error: "invalid_response", error_description: raw.slice(0, 500) };
  }

  if (!res.ok) {
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    throw new Error(`Google token exchange failed: ${detail}`);
  }

  return data;
}

function htmlPage(title, bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 16px;line-height:1.5}
pre{background:#f4f4f5;padding:12px;border-radius:6px;word-break:break-all;white-space:pre-wrap}</style>
</head><body>${bodyHtml}</body></html>`;
}

function startServer() {
  const { clientId, clientSecret } = requireClientCredentials();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === "/") {
      res.writeHead(302, { Location: buildAuthUrl(clientId) });
      res.end();
      return;
    }

    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const error = url.searchParams.get("error");
    if (error) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(htmlPage("OAuth error", `<h1>OAuth error</h1><pre>${error}</pre>`));
      console.error(`\nGoogle returned an error: ${error}`);
      return;
    }

    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(htmlPage("Missing code", "<h1>Missing authorization code</h1>"));
      return;
    }

    try {
      const tokens = await exchangeCodeForTokens(code, clientId, clientSecret);

      if (!tokens.refresh_token) {
        const advice =
          "Google did not return a refresh token. Revoke this app at " +
          "https://myaccount.google.com/permissions and run the helper again. " +
          "Google only issues a refresh token on first consent or after a revoke.";
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(htmlPage("No refresh token", `<h1>No refresh token</h1><p>${advice}</p>`));
        console.error(`\n${advice}`);
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        htmlPage(
          "Refresh token",
          `<h1>Success</h1>
           <p>Copy this into <code>.env</code> as <code>GOOGLE_REFRESH_TOKEN</code>, then stop the helper.</p>
           <pre>${tokens.refresh_token}</pre>
           <p>Granted scopes:</p><pre>${tokens.scope || "(not reported)"}</pre>`
        )
      );

      console.log("\n=== GOOGLE REFRESH TOKEN ===");
      console.log(tokens.refresh_token);
      console.log("============================");
      console.log("\nAdd it to .env as GOOGLE_REFRESH_TOKEN, then press Ctrl+C and run: npm start\n");
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end(htmlPage("Token exchange failed", `<h1>Token exchange failed</h1><pre>${err.message}</pre>`));
      console.error(`\n${err.message}`);
    }
  });

  server.listen(PORT, () => {
    console.log(`\nOpen http://localhost:${PORT} to start the Google OAuth flow.`);
    console.log(`Redirect URI: ${REDIRECT_URI}`);
    console.log(
      "\nThat exact redirect URI must be listed under Google Cloud Console >\n" +
        "APIs & Services > Credentials > your OAuth 2.0 Client > Authorized redirect URIs.\n"
    );
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\nPort ${PORT} is already in use. Set OAUTH_PORT in .env and try again.`);
      console.error("Remember to add the new redirect URI in Google Cloud Console too.\n");
      process.exit(1);
    }
    throw err;
  });
}

startServer();
