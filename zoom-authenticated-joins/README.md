# Authenticated Zoom Joins with ZAK and OBF Tokens for MeetStream Bots

Host the Zoom OAuth grant and the token URL that MeetStream API bots call at join time, so a meeting bot joins Zoom as a signed-in user (ZAK) or on behalf of a user already in the meeting (OBF) instead of as a guest stuck in the waiting room. Zoom only; Google Meet and Microsoft Teams have their own signed-in bot flows.

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

## Prerequisites

- Node.js 18 or newer
- A Zoom General App with Meeting SDK enabled and the `user:read:zak` / `user:read:token` scopes (see above)
- A public https tunnel to this machine (`ngrok` or `cloudflared`); MeetStream bots run in AWS and cannot reach `localhost`
- A MeetStream API key from <https://app.meetstream.ai> for `create-bot`

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/zoom-authenticated-joins
npm install
cp .env.example .env         # ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, MINT_SHARED_SECRET (openssl rand -hex 32)
ngrok http 3000              # second terminal; put the https URL in PUBLIC_BASE_URL, no trailing slash
node index.js                # token server
```

`cloudflared tunnel --url http://localhost:3000` also works, but it gives a new URL every run, so re-register the redirect URL on the Zoom app each time. Add `MEETSTREAM_API_KEY` when you are ready to run `create-bot`.

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

`create-bot` treats HTTP 201 and 507 (idempotent replay) as success, fails if the response has no `bot_id`, and prints the API `message` on any error. It retries only 429, 5xx and network errors (3 attempts, exponential backoff, `Retry-After` honoured); every other 4xx is final. Nothing in this template polls: `create-bot` exits after the one call, and the token server is a long-running process that answers mint requests until Ctrl+C. If you add a wait for the bot to reach the meeting (for example polling `GET /bots/{bot_id}/status`), cap the attempts and print why you gave up.

Secrets never reach the terminal: the `auth` value on the mint URL and the Zoom `pwd` passcode are shown as `***` in the printed body and in any error message, `--dry-run` output included, and no route logs a ZAK, OBF, access or refresh token.

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

## Environment variables

| Name | Required | Default | Meaning |
|---|---|---|---|
| `ZOOM_CLIENT_ID` | server | | Zoom General App |
| `ZOOM_CLIENT_SECRET` | server | | Zoom General App |
| `PUBLIC_BASE_URL` | yes | | Public https tunnel URL, no trailing slash, never `localhost` |
| `MINT_SHARED_SECRET` | yes | | `?auth=` value on every mint URL. Use 32+ random characters |
| `MEETSTREAM_API_KEY` | create-bot | | From https://app.meetstream.ai, sent as `Authorization: Token <key>`. The token server (`node index.js`) never calls MeetStream and does not need it; `create-bot --dry-run` does not either |
| `ZOOM_REDIRECT_URI` | no | `PUBLIC_BASE_URL/zoom/callback` | Must match the Zoom app exactly |
| `PORT` | no | `3000` | Point the tunnel here |
| `DATA_DIR` | no | `./data` | Where refresh tokens are written |
| `MEETSTREAM_API_BASE_URL` | no | `https://api.meetstream.ai/api/v1` | Override for testing |

**Recording defaults.** This template records audio only, and now sends `video_required: false` explicitly: the REST API treats an omitted `video_required` as **true**, so leaving the field out silently records video. If you turn video on, also send `recording_config.video_layout: "speaker_view"`, because the API default is `grid_view`; use `grid_view` only when you want the mosaic of everyone. Per-participant video (`video_separate_streams`) is never set here.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing ... in .env` | Placeholders still in `.env` | Copy `.env.example` to `.env` and replace every placeholder. |
| `MEETSTREAM_API_KEY is not set` / `Missing MEETSTREAM_API_KEY in .env` | `create-bot` run without a key (the server does not need one) | Add it to `.env`, or use `--dry-run`. |
| MeetStream 401 / 403 on `create-bot` | `MEETSTREAM_API_KEY` missing or rejected | Set or regenerate it; header is `Authorization: Token <key>`. |
| `create_bot returned HTTP 429` / `5xx (gave up after 3 attempts)` | Rate limit or transient server error; retried with backoff | Wait a minute and run again. |
| `Could not reach MeetStream after 3 attempts` | DNS or connection failure, retried 3 times | Check connectivity and `MEETSTREAM_API_BASE_URL`. |
| `create_bot returned HTTP 2xx but no bot_id` | Unexpected response shape | Inspect the printed body; check `MEETSTREAM_API_BASE_URL` points at the real API. |
| MeetStream 400: `Pass only one of zoom.zak_url or zoom.obf_url` | Both URLs were sent | Pick one per bot. |
| MeetStream 400: `use_zoom_obf is no longer supported` | Old code still sends `use_zoom_obf` or `zoom_oauth_connection_user_id` | Remove them and send `zoom.zak_url` or `zoom.obf_url`. |
| MeetStream 507 on `create-bot` | Idempotent replay | Treated as success; the original bot is returned. |
| `must use https` / `must include a host` | `PUBLIC_BASE_URL` is `http://`, `localhost`, or malformed | Use the tunnel's https URL. |
| Bot fails at join: `OBF token is required but could not be fetched` (same for a failing `zak_url`) | Your mint URL returned non-2xx; check this server's `[mint]` log line for the bot id | See the mint-URL rows below. |
| Mint URL `400` | `meeting_number` was on the `obf_url` you passed to `create_bot` and arrived twice, or `user_id` is missing | Drop `meeting_number` from the URL; MeetStream appends it. |
| Mint URL `401` | `auth` does not match `MINT_SHARED_SECRET` | Was the secret rotated after the bot was created? Recreate the bot. |
| Mint URL `404` | That `user_id` never completed `/zoom/connect` | Have the user connect. |
| Mint URL `409` | The Zoom grant is dead (app revoked, or refresh token expired unused) | Have them connect again. |
| Mint URL `502` | Zoom refused to mint | Check scopes (`user:read:zak`, `user:read:token`) and that Meeting SDK is enabled for OBF. |
| No `[mint]` log line at all | Tunnel is down, or `PUBLIC_BASE_URL` points at an old tunnel URL | Restart the tunnel and update `.env`. |
| OBF bot is never admitted, or disappears | The parent user must already be in the meeting; Zoom removes the bot when they leave | If they join late, raise `automatic_leave.waiting_room_timeout`. |
| Zoom says "Invalid redirect" before the consent screen | Redirect URL on the Zoom app does not match `ZOOM_REDIRECT_URI` byte for byte | Fix scheme, host, path and trailing slash. With cloudflared the host changes every run. |
| "Link expired" after approving in Zoom | `state` was not issued by this process (server restarted, or an old tab) | Start again from `/zoom/connect`. |

## Related

- [Zoom authenticated bots (ZAK and OBF)](https://docs.meetstream.ai/guides/app-integrations/zoom-authenticated-bots)
- [Zoom Marketplace app setup](https://docs.meetstream.ai/guides/app-integrations/zoom-marketplace-app-setup)
- [Zoom app production submission](https://docs.meetstream.ai/guides/app-integrations/zoom-app-production-submission)
- [Zoom platform guide](https://docs.meetstream.ai/guides/platforms/zoom)
- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [Error codes](https://docs.meetstream.ai/errors)
- [Zoom: OBF FAQ](https://developers.zoom.us/docs/meeting-sdk/obf-faq/)
- [Zoom: OAuth for apps](https://developers.zoom.us/docs/integrations/oauth/)
- Labs: [zoom-meeting-bot](../zoom-meeting-bot) handles Zoom's recording-permission flow once the bot is in; [webhook-local-tunnel](../webhook-local-tunnel) covers running a public https URL for local development; [google-signed-in-bots-setup](../google-signed-in-bots-setup) and [teams-signed-in-bots-setup](../teams-signed-in-bots-setup) are the equivalents for the other platforms
