/**
 * One-time Microsoft / Outlook OAuth helper.
 *
 * Runs a tiny local HTTP server, sends you through the Microsoft identity
 * platform consent screen and prints the refresh token that MeetStream needs.
 * No SDK required: this talks to the v2.0 endpoints directly with fetch.
 *
 * Run it with:  npm run oauth
 */

import "dotenv/config";
import http from "node:http";

const PORT = Number(process.env.OAUTH_PORT || 3000);
const CALLBACK_PATH = "/api/microsoft/oauth-callback";
const REDIRECT_URI = `http://localhost:${PORT}${CALLBACK_PATH}`;

/**
 * "common" accepts both work/school (Microsoft 365) and personal Microsoft
 * accounts. Set MICROSOFT_TENANT_ID to your directory id to lock the flow to
 * a single tenant, or to "organizations" to exclude personal accounts.
 */
const TENANT = process.env.MICROSOFT_TENANT_ID || "common";
const AUTH_ENDPOINT = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`;
const TOKEN_ENDPOINT = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;

/**
 * offline_access is the scope that makes Microsoft return a refresh token.
 * Without it you get an access token that dies in about an hour.
 */
export const SCOPES = ["offline_access", "User.Read", "Calendars.Read"];

function requireClientCredentials() {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error(
      "\nMICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET must be set before running the OAuth helper."
    );
    console.error("Copy .env.example to .env and fill in the values from");
    console.error("Azure Portal > App registrations > your app.\n");
    process.exit(1);
  }

  return { clientId, clientSecret };
}

function buildAuthUrl(clientId) {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

async function exchangeCodeForTokens(code, clientId, clientSecret) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
      scope: SCOPES.join(" "),
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
    throw new Error(`Microsoft token exchange failed: ${detail}`);
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
      const description = url.searchParams.get("error_description") || "";
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(htmlPage("OAuth error", `<h1>OAuth error</h1><pre>${error}\n\n${description}</pre>`));
      console.error(`\nMicrosoft returned an error: ${error}\n${description}`);
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
          "Microsoft did not return a refresh token. Make sure offline_access is " +
          "listed under API permissions and that you accepted it on the consent screen.";
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
           <p>Copy this into <code>.env</code> as <code>MICROSOFT_REFRESH_TOKEN</code>, then stop the helper.</p>
           <pre>${tokens.refresh_token}</pre>
           <p>Granted scopes:</p><pre>${tokens.scope || "(not reported)"}</pre>`
        )
      );

      console.log("\n=== MICROSOFT REFRESH TOKEN ===");
      console.log(tokens.refresh_token);
      console.log("===============================");
      console.log("\nAdd it to .env as MICROSOFT_REFRESH_TOKEN, then press Ctrl+C and run: npm start\n");
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end(htmlPage("Token exchange failed", `<h1>Token exchange failed</h1><pre>${err.message}</pre>`));
      console.error(`\n${err.message}`);
    }
  });

  server.listen(PORT, () => {
    console.log(`\nOpen http://localhost:${PORT} to start the Microsoft OAuth flow.`);
    console.log(`Redirect URI: ${REDIRECT_URI}`);
    console.log(`Tenant      : ${TENANT}`);
    console.log(
      "\nThat exact redirect URI must be listed under Azure Portal >\n" +
        "App registrations > your app > Authentication > Redirect URIs (platform: Web).\n"
    );
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\nPort ${PORT} is already in use. Set OAUTH_PORT in .env and try again.`);
      console.error("Remember to add the new redirect URI in the Azure Portal too.\n");
      process.exit(1);
    }
    throw err;
  });
}

startServer();
