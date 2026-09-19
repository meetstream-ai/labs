# zoom-authenticated-joins

Host the Zoom token URL that MeetStream bots call at join time, so a bot joins Zoom as a signed-in user (ZAK) or on behalf of a user already in the meeting (OBF) instead of as a guest.

```bash
npm install
cp .env.example .env     # ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, PUBLIC_BASE_URL, MINT_SHARED_SECRET, MEETSTREAM_API_KEY
ngrok http 3000          # in a second terminal; put the https URL in PUBLIC_BASE_URL
node index.js            # token server
```

Then, once per Zoom user, open `https://<PUBLIC_BASE_URL>/zoom/connect?user_id=alice&auth=<MINT_SHARED_SECRET>` in their browser, and send a bot:

```bash
node index.js create-bot --meeting "https://zoom.us/j/123456789?pwd=..." --mode zak --user alice
```

---

## Guest, ZAK, or OBF

The `zoom` block on `create_bot` picks how the bot gets into a Zoom meeting:

| `zoom` on create_bot | Bot joins as | Parent must be in the meeting |
|---|---|---|
| omitted or `{}` | a guest (waiting room, host admits) | no |
| `{ "zak_url": "https://..." }` | the signed-in Zoom user whose token you mint | no |
| `{ "obf_url": "https://..." }` | an assistant on behalf of that user | **yes**, and Zoom removes the bot when they leave |

Send one URL, never both (the API returns 400). The old `zoom.use_zoom_obf` and `zoom.zoom_oauth_connection_user_id` fields, and the hosted `/zoom/oauth/*` endpoints, are gone: `create_bot` rejects those fields.

## How it works

You run Zoom OAuth. MeetStream never sees your users' refresh tokens; it only ever sees a short-lived ZAK or OBF token, fetched from a URL you host, at the moment the bot joins.

```
once per user      browser -> /zoom/connect -> zoom.us consent -> /zoom/callback
                   this server trades the code for tokens and stores the refresh_token

create_bot         you -> MeetStream  { zoom: { zak_url: "https://you/zoom/zak?user_id=alice&auth=..." } }

join time          MeetStream bot -> GET https://you/zoom/zak?user_id=alice&auth=...
                   this server: refresh access token -> GET api.zoom.us/v2/users/me/token?type=zak
                   <- 200 text/plain  <token>
```

The server in this template:

| Route | Who calls it | What it does |
|---|---|---|
| `GET /zoom/connect?user_id=&auth=` | your user's browser | Redirects to Zoom's consent screen with a random `state` |
| `GET /zoom/callback` | Zoom | Checks `state`, exchanges the `code` (HTTP Basic auth), stores the `refresh_token` |
| `GET\|POST /zoom/zak?user_id=&auth=` | MeetStream bot | Refreshes the access token if needed, mints a ZAK, returns it as `text/plain` |
| `GET\|POST /zoom/obf?user_id=&auth=` | MeetStream bot | Same, with the `meeting_number` MeetStream appends, mints an OBF |
| `GET /healthz` | you | `{ "ok": true }` |

`node index.js create-bot` builds the right `zak_url` or `obf_url` from `PUBLIC_BASE_URL` and calls `POST /bots/create_bot`.

## Zoom app setup (one time)

Use one Zoom **General App** for both halves: the Meeting SDK app the bot runs as, and the OAuth grant your users approve.

1. Zoom App Marketplace, **Develop -> Build App -> General App**.
2. **Features -> Embed**: enable **Meeting SDK** (required for OBF).
3. **OAuth Redirect URL**: `https://<PUBLIC_BASE_URL>/zoom/callback`, exactly, and add the same host to the **OAuth Allow List**. The server prints the exact value it uses on boot.
4. **Scopes**: `user:read:zak` for ZAK, `user:read:token` for OBF. Add `user:read:user` only if you change the template to key users by Zoom user id.
5. Copy the **Client ID** and **Client Secret** into `.env` here, and into the MeetStream dashboard under **Integrations -> Zoom**. The dashboard copy is what the bot joins with; it is not the end-user grant.

Until the Zoom app is approved for production, it only works for a limited set of users. See the development vs production notes in [`zoom-meeting-bot`](../zoom-meeting-bot).

## Setup

1. `npm install`
2. `cp .env.example .env`
3. Fill in `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, and a long `MINT_SHARED_SECRET` (`openssl rand -hex 32`)
4. Start a tunnel to `PORT` (default 3000). MeetStream bots run in AWS and cannot reach `localhost`, so the mint URL has to be public https:
   - `ngrok http 3000`, or
   - `cloudflared tunnel --url http://localhost:3000` (no account, new URL every run, so re-register the redirect URL on Zoom each time)
5. Put the tunnel's https URL in `PUBLIC_BASE_URL` (no trailing slash)
6. `node index.js`
7. Add `MEETSTREAM_API_KEY` when you are ready to run `create-bot`

## Run

```bash
# Token server. Leave it running; bots call it at join time.
node index.js

# Connect a Zoom user once. Open in THEIR browser; they sign in to Zoom and click Allow.
open "https://<PUBLIC_BASE_URL>/zoom/connect?user_id=alice&auth=<MINT_SHARED_SECRET>"

# Bot joins as alice.
node index.js create-bot --meeting "https://zoom.us/j/123456789?pwd=..." --mode zak --user alice

# Bot joins on behalf of alice. alice must already be in the meeting.
node index.js create-bot --meeting "https://zoom.us/j/123456789?pwd=..." --mode obf --user alice

# Plain guest join, for comparison.
node index.js create-bot --meeting "https://zoom.us/j/123456789?pwd=..." --mode guest

# Print the create_bot body (auth redacted) without calling MeetStream.
node index.js create-bot --meeting "https://zoom.us/j/123456789" --mode obf --user alice --dry-run
```

`create-bot` treats HTTP 201 and 507 (idempotent replay) as success and prints the API `message` on any error.

## Test the mint URL without a bot

```bash
curl -sS -D - -H "X-Bot-Id: test-bot" "https://<PUBLIC_BASE_URL>/zoom/zak?user_id=alice&auth=<MINT_SHARED_SECRET>"
curl -sS -D - -H "X-Bot-Id: test-bot" "https://<PUBLIC_BASE_URL>/zoom/obf?user_id=alice&auth=<MINT_SHARED_SECRET>&meeting_number=123456789"
```

Expect `200`, `Content-Type: text/plain`, and a long token. Without `auth` you get `401`. For a `user_id` that never connected you get `404` with the connect link. Going through the tunnel URL (not `localhost`) also proves MeetStream can reach you.

## The mint contract

This is what MeetStream's bot does with your `zak_url` / `obf_url`, and what this server implements.

**Request.** The bot tries `GET` first. If you answer `405`, or the body cannot be parsed as a token, it retries as `POST` with JSON. A `400` on `GET` is final and is not retried.

| | ZAK | OBF |
|---|---|---|
| GET query | your URL as-is | your URL plus `meeting_number` (appended by MeetStream) |
| POST body | `{ "bot_id", "webhook_secret"? }` | `{ "bot_id", "meeting_number", "webhook_secret"? }` |
| Headers | `X-Bot-Id`, plus `X-Webhook-Secret` if the bot has one | same |

**Response.** `200` with `Content-Type: text/plain` and the raw token (longer than 50 characters), or JSON `{"token": "..."}`, `{"zak": "..."}`, or `{"obf": "..."}`. Anything non-2xx is a failure, and because you set a token URL, the bot does not fall back to a guest join.

**Zoom calls behind it.**

- ZAK: `GET https://api.zoom.us/v2/users/me/token?type=zak`
- OBF: `GET https://api.zoom.us/v2/users/me/token?type=onbehalf&meeting_id=<meeting_number>`

Both return `{ "token": "..." }`. OBF tokens are short-lived and single-use, so they are minted when MeetStream calls, never at `create_bot` time.

**Rules this server follows.**

- The URL is a credential. `user_id` says whose token to mint, and `auth` is a shared secret compared in constant time. Rotate it if a URL leaks.
- Never put `meeting_number` on the `obf_url` you pass to `create_bot`. MeetStream appends it, so it would arrive twice, which many frameworks parse as an array. This server defensively takes the first value and logs a warning.
- Zoom rotates refresh tokens. Every refresh that returns a new `refresh_token` is persisted immediately, and parallel joins for the same user share one refresh.
- Tokens and secrets are never logged. Log lines carry the bot id, user id, meeting number, and status only.
- `HEAD` returns `405`, so a link checker cannot burn a token.

## Moving to production

- **Refresh tokens.** This template writes them to `data/zoom-tokens.json` (gitignored, mode 600) so it runs with no infrastructure. In production keep them in a secret store or an encrypted column (KMS, Vault, Secrets Manager, pgcrypto). `src/token-store.js` is the only file to change.
- **`/zoom/connect`.** Here it takes `user_id` from the query and is guarded by `MINT_SHARED_SECRET`. In your app it belongs behind your own login, with `user_id` taken from the session.
- **Auth on the mint URL.** A shared secret is the simplest option. A per-user or per-bot HMAC over `user_id` (and an expiry) limits the damage if one URL leaks.
- **Multiple instances.** OAuth `state` and the access-token cache are in memory. Move them to a shared store (Redis, your DB) if you run more than one instance.

## Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `ZOOM_CLIENT_ID` | server | | Zoom General App |
| `ZOOM_CLIENT_SECRET` | server | | Zoom General App |
| `PUBLIC_BASE_URL` | yes | | Public https tunnel URL, no trailing slash, never `localhost` |
| `MINT_SHARED_SECRET` | yes | | `?auth=` value on every mint URL. Use 32+ random characters |
| `MEETSTREAM_API_KEY` | create-bot | | From https://app.meetstream.ai, sent as `Authorization: Token <key>` |
| `ZOOM_REDIRECT_URI` | no | `PUBLIC_BASE_URL/zoom/callback` | Must match the Zoom app exactly |
| `PORT` | no | `3000` | Point the tunnel here |
| `DATA_DIR` | no | `./data` | Where refresh tokens are written |
| `MEETSTREAM_API_BASE_URL` | no | `https://api.meetstream.ai/api/v1` | Override for testing |

## Troubleshooting

**`Pass only one of zoom.zak_url or zoom.obf_url`** - both were sent. Pick one per bot.

**`must use https` / `must include a host`** - `PUBLIC_BASE_URL` is `http://`, `localhost`, or malformed. Use the tunnel's https URL.

**`use_zoom_obf is no longer supported`** - old code is still sending `use_zoom_obf` or `zoom_oauth_connection_user_id`. Remove them and send `zoom.zak_url` or `zoom.obf_url`.

**Bot fails at join with `OBF token is required but could not be fetched`** - your URL returned non-2xx at join time (the same causes apply to a failing `zak_url`). Check this server's `[mint]` log line for the bot id. Usual causes:
- `400`: `meeting_number` was on the `obf_url` you passed to `create_bot` and arrived twice, or `user_id` is missing
- `401`: `auth` does not match `MINT_SHARED_SECRET` (secret rotated after the bot was created?)
- `404`: that `user_id` never completed `/zoom/connect`
- `409`: the Zoom grant is dead (user revoked the app, or the refresh token expired unused). Have them connect again
- `502`: Zoom refused to mint. Check scopes (`user:read:zak`, `user:read:token`) and that Meeting SDK is enabled for OBF
- no log line at all: the tunnel is down or `PUBLIC_BASE_URL` points at an old tunnel URL

**OBF bot is never admitted, or disappears** - the parent user must already be in the meeting, and Zoom removes the bot when they leave. If they join late, raise `automatic_leave.waiting_room_timeout` on `create_bot`.

**Zoom says "Invalid redirect" before the consent screen** - the redirect URL on the Zoom app does not match `ZOOM_REDIRECT_URI` byte for byte (scheme, host, path, trailing slash). With cloudflared the host changes every run.

**"Link expired" after approving in Zoom** - the `state` was not issued by this process (server restarted, or an old tab). Start again from `/zoom/connect`.

**`Missing ... in .env`** - copy `.env.example` to `.env` and replace every placeholder.

## Reference

- [Zoom Authenticated Bots (ZAK and OBF)](https://docs.meetstream.ai/guides/app-integrations/zoom-authenticated-bots)
- [Zoom Marketplace App Setup](https://docs.meetstream.ai/guides/app-integrations/zoom-marketplace-app-setup)
- [Zoom: OBF FAQ](https://developers.zoom.us/docs/meeting-sdk/obf-faq/)
- [Zoom: OAuth for apps](https://developers.zoom.us/docs/integrations/oauth/)

## Next

- [`zoom-meeting-bot`](../zoom-meeting-bot) handles Zoom's recording-permission flow once the bot is in
- [`webhook-local-tunnel`](../webhook-local-tunnel) covers running a public https URL for local development
