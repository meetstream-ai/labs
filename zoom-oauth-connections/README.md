# zoom-oauth-connections

Let one of your end users connect their own Zoom account to MeetStream, so bots can join meetings on their behalf. This template runs the whole hosted OAuth flow from the terminal: it gets the authorize URL, catches Zoom's redirect on a tiny local Express server, exchanges the code, and then lists, reads, and deletes stored connections.

```bash
npm install
cp .env.example .env   # then fill in MEETSTREAM_API_KEY and ZOOM_REDIRECT_URI
node index.js connect
```

## What this unlocks

Zoom will not let an arbitrary bot record an arbitrary meeting. Two separate things have to be true, and they are easy to confuse.

**1. Your Zoom Marketplace app (one-time, done by you).** You create an OAuth app in the Zoom Marketplace, give it the scopes MeetStream needs, and register your redirect URL on it. This is the identity that Zoom shows on the consent screen and the thing Zoom checks the redirect URL against. You do this once for your product, in the Zoom UI, outside this template. MeetStream needs to know about that app, so hosted Zoom OAuth is enabled per account by MeetStream.

**2. Each end user's consent (many times, done by this template).** Every Zoom user who wants your bot in their meetings has to click Allow on Zoom's consent screen. That produces a per-user grant. The endpoints here are the API surface for capturing and managing those grants.

So the Marketplace app answers "is this application allowed to ask?" and a connection answers "did this particular user say yes?". Without the app there is nothing to authorize against. Without a connection you have an app but no user has said yes, so bots cannot act on anyone's behalf.

What you get once a user is connected:

- Bots join that user's Zoom meetings as an authorized participant instead of an outside guest, so they are not stuck in the lobby waiting for a manual admit.
- MeetStream stores and refreshes the Zoom tokens. Your side never holds Zoom access or refresh tokens, and the API never returns them.
- Your only handle is the returned `zoom_user_id`. Save it against your own user record.

## Prerequisites

- Node.js 18 or newer (the code uses the built-in `fetch`)
- A MeetStream API key from https://app.meetstream.ai
- A Zoom Marketplace OAuth app, with hosted Zoom OAuth enabled on your MeetStream account
- A redirect URL registered on that Zoom app. Zoom requires HTTPS, so for local development run a tunnel such as `ngrok http 3000` and register the tunnel URL.

## The redirect URI rule

`redirect_uri` appears in three places and all three must be byte-for-byte identical:

1. the redirect URL registered on your Zoom Marketplace app
2. the `redirect_uri` query parameter on `GET /zoom/oauth/authorize-url`
3. the `redirect_uri` field in the body of `POST /zoom/oauth/connections`

"Byte-for-byte" means the same scheme, host, port, and path, including whether there is a trailing slash. `https://app.example.com/zoom/callback` and `https://app.example.com/zoom/callback/` are two different URLs to Zoom. A mismatch at step 2 fails on Zoom's side with an invalid redirect error before the user ever sees a consent screen. A mismatch at step 3 fails on MeetStream's side with an HTTP 400.

This template reads the value once, from `ZOOM_REDIRECT_URI` or `--redirect-uri`, and uses that same string for both API calls, so steps 2 and 3 cannot drift apart. Step 1 is on you, in the Zoom UI.

## Setup

1. `npm install`
2. `cp .env.example .env`
3. Set `MEETSTREAM_API_KEY`
4. Set `ZOOM_REDIRECT_URI` to the URL registered on your Zoom app
5. If that URL is a tunnel, start the tunnel pointing at `PORT` (default 3000)
6. `node index.js connect`

## Commands

```
node index.js connect                    full flow, ending in a stored connection
node index.js authorize-url              print the authorize URL and exit
node index.js list                       every stored connection
node index.js get <zoom_user_id>         one connection
node index.js delete <zoom_user_id> --yes  disconnect that user
node index.js --help                     all options
```

Add `--json` to any command to get the raw API response instead of the formatted view.

## What `connect` does

**Step 1. Get the authorize URL**

```http
GET /zoom/oauth/authorize-url?redirect_uri=https%3A%2F%2Fapp.example.com%2Fzoom%2Fcallback&state=usr_1842
Authorization: Token <your key>
```

Response is `{ "authorize_url": "https://zoom.us/oauth/authorize?..." }`. The template prints it for the end user to open.

`state` is optional and opaque. Zoom round-trips it back to your callback untouched, which makes it the natural place to carry your own end-user id so the callback knows whose account just got connected. This template generates a random `state` when you do not pass one and refuses any callback whose `state` does not match, which is the standard CSRF guard. Pass your own with `--state`.

**Step 2. Catch the redirect**

A local Express server listens on the path from your redirect URI. Zoom sends the browser there with either:

```
?code=<authorization code>&state=<what you sent>
?error=access_denied&error_description=<why>
```

The server answers with a small "you can close this tab" page and hands the code back to the CLI. It gives up after `--timeout` seconds (default 300).

In a real product this is a route inside your own web app, not a process that exits after one callback. `node index.js authorize-url` exists for exactly that case: your app owns the route and does the exchange itself.

**Step 3. Exchange the code**

```http
POST /zoom/oauth/connections
Authorization: Token <your key>
Content-Type: application/json

{
  "code": "<the code from step 2>",
  "redirect_uri": "https://app.example.com/zoom/callback",
  "metadata": { "tenant_user_id": "usr_1842" }
}
```

`metadata` is optional. It is a flat map of your own key/value pairs, and the values must be strings. Use it to tie the connection back to your own records. Add pairs with `--meta key=value`, repeatable.

The response is the stored connection:

```json
{
  "zoom_user_id": "abc123XYZ",
  "zoom_account_id": "...",
  "email": "user@example.com",
  "display_name": "Casey Rivera",
  "metadata": { "tenant_user_id": "usr_1842" },
  "state": "...",
  "created_at": "...",
  "updated_at": "...",
  "has_refresh_token": true
}
```

Authorization codes are single-use and short-lived. If the exchange fails, run `connect` again to get a fresh one rather than retrying the old code.

## Using a connection

Save `zoom_user_id` against your end-user record. Pass it back on `create_bot` for a Zoom meeting owned by that user:

```json
{
  "meeting_link": "https://zoom.us/j/1234567890",
  "bot_name": "Notetaker",
  "zoom": {
    "use_zoom_obf": true,
    "zoom_oauth_connection_user_id": "abc123XYZ"
  }
}
```

`zoom.use_zoom_obf` turns on Zoom's On-Behalf-Of path, and `zoom.zoom_oauth_connection_user_id` names which stored connection to act as. OBF is the "on behalf of" framework: the bot joins under a real user's grant instead of as an anonymous guest.

## Managing connections

`list` and `get` return identity, metadata, state, and timestamps. Token material is never returned by either one, so these are safe to log and safe to expose in an internal admin view.

`delete` disconnects the user. Bots can no longer be created on their behalf until they go through Zoom's consent screen again, so the command requires `--yes`.

## Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MEETSTREAM_API_KEY` | yes | | From https://app.meetstream.ai |
| `ZOOM_REDIRECT_URI` | yes | | Must match the Zoom app's registered redirect URL exactly |
| `PORT` | no | `3000` | Local port the callback listener binds to |
| `MEETSTREAM_API_BASE_URL` | no | `https://api.meetstream.ai/api/v1` | Override for testing |

`--redirect-uri`, `--port`, `--state`, and `--timeout` override the environment per run.

## Troubleshooting

**Zoom shows "Invalid redirect: ..." before any consent screen** - the `redirect_uri` sent to `authorize-url` is not registered on the Zoom app. Compare the two strings character by character, including the trailing slash.

**`API error 400` on the exchange** - either the code was already used, the code expired, or the `redirect_uri` in the POST body differs from the one used on `authorize-url`. Run `connect` again for a fresh code.

**`API error 401` / `403`** - `MEETSTREAM_API_KEY` is empty or was rejected. Copy it again in full, with no trailing whitespace. A 403 can also mean hosted Zoom OAuth is not enabled on your account yet.

**No callback arrives and the command times out** - the tunnel is not running, is forwarding to a different port, or the registered redirect URL points somewhere other than this listener. `curl http://localhost:3000/healthz` confirms the local server is up; hitting the public redirect URL's `/healthz` confirms the tunnel reaches it.

**"State mismatch" in the browser** - the callback did not come from the authorize URL this run generated. Usually a stale browser tab from an earlier attempt. Start over with a fresh `connect`.

**`Port 3000 is already in use`** - another process holds it. Pass `--port` and point the tunnel at the new port.

**Bot still lands in the lobby after connecting** - the meeting is not owned by the connected Zoom user, or `zoom.zoom_oauth_connection_user_id` was not passed on `create_bot`. A connection only helps for meetings that user owns.

## Reference

- [MeetStream docs](https://docs.meetstream.ai)
- [API reference](https://docs.meetstream.ai/api-reference)
- [Zoom Marketplace: OAuth apps](https://developers.zoom.us/docs/integrations/oauth/)

## Next

- `zoom-meeting-bot` sends a bot into a Zoom meeting once a connection exists
- `webhook-local-tunnel` covers running a public callback URL for local development
