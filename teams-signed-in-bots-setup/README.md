# Set Up Microsoft Teams Signed-In Bots with the MeetStream API

Set up MeetStream signed-in meeting bots for Microsoft Teams end to end: the Microsoft 365 tenant checklist, login domain and bot account registration through the MeetStream API (`/teams-login-domains`, `/teams-logins`), day-to-day account management, and a `create_bot` request with `teams.login_required` so the bot joins as a real Microsoft 365 user.

```bash
npm install
cp .env.example .env              # fill in MEETSTREAM_API_KEY, TEAMS_LOGIN_DOMAIN, the bot accounts
node index.js                     # prints the Microsoft 365 checklist and every command
node index.js setup --dry-run     # shows every request it would send, passwords redacted
node index.js setup               # registers the domain and accounts, then shows lease status
```

---

## Prerequisites

- Node 18+
- A MeetStream API key from [app.meetstream.ai](https://app.meetstream.ai)
- A Microsoft 365 tenant prepared as below (`node index.js checklist` prints this list)

### Microsoft 365 checklist

| # | Requirement | Why |
| --- | --- | --- |
| 1 | A **dedicated** Microsoft 365 tenant just for bot accounts | The settings below relax sign-in security. Keep them away from real users. |
| 2 | **Microsoft 365 Business Basic** or higher, one licence per bot account | The account needs a Teams licence to join meetings. |
| 3 | One regular, **non-admin**, licensed user per bot, on the domain you register (e.g. `bot1@bots.acme.com`) | Admin accounts get extra sign-in checks. Give each a permanent password (untick "require password change at first sign-in"), and set the display name and photo you want meetings to show. |
| 4 | **Security defaults disabled** (Entra admin center -> Overview -> Properties -> Manage security defaults) | Otherwise Microsoft forces an MFA registration prompt the bot cannot answer. |
| 5 | **Self-service password reset set to None** for the bot accounts (Entra admin center -> Password reset -> Properties) | Keeps "more information required" screens out of the sign-in flow. |
| 6 | Meetings are **work or school Teams** (`teams.microsoft.com`) | `teams.live.com` meetings are not supported. |

---

## What a signed-in Teams bot is

By default a MeetStream bot joins a Teams meeting as an **anonymous guest** under `bot_name`. A **signed-in bot** first logs into a real Microsoft 365 account that you own, and joins as that user: it shows that account's display name and profile picture.

You register the accounts with MeetStream once. After that, adding a `teams` block to `create_bot` is all it takes:

```json
"teams": {
  "login_required": true,
  "teams_login_domain": "bots.acme.com",
  "sign_in_email": "bot1@bots.acme.com",
  "strict_email": true
}
```

Three rules shape everything else:

- **One account = one concurrent bot.** An account that is in a meeting is leased until it leaves. For N simultaneous signed-in bots, register N accounts.
- **The name and picture come from Microsoft.** `bot_name` and `bot_image_url` are not applied to a signed-in Teams bot. Set the display name and photo on the Microsoft 365 user.
- **Work or school Teams only.** Meetings on `teams.microsoft.com` work; Teams for personal use (`teams.live.com`) does not.

---

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/teams-signed-in-bots-setup
npm install
cp .env.example .env              # fill in MEETSTREAM_API_KEY, TEAMS_LOGIN_DOMAIN, the bot accounts
node index.js                     # prints the Microsoft 365 checklist and every command
node index.js setup --dry-run     # shows every request it would send, passwords redacted
node index.js setup               # registers the domain and accounts, then shows lease status
```

## Environment variables

Everything comes from `.env` (see `.env.example`).

| Variable | Required | Meaning |
| --- | --- | --- |
| `MEETSTREAM_API_KEY` | yes (not with `--dry-run`) | API key, sent as `Authorization: Token <key>` |
| `MEETSTREAM_BASE_URL` | no | API base URL (default `https://api.meetstream.ai/api/v1`) |
| `TEAMS_LOGIN_DOMAIN` | yes | The part after the @ in the bot emails, e.g. `bots.acme.com`; `--domain` overrides it |
| `TEAMS_DOMAIN_NAME` | no | Label for the domain entry (`register-domain`) |
| `TEAMS_BOT_ACCOUNTS` | for `add-accounts` | Comma-separated bot emails |
| `TEAMS_BOT_PASSWORD_1`, `_2`, ... | no | Password for the 1st, 2nd, ... email in `TEAMS_BOT_ACCOUNTS`; unset = hidden prompt |
| `TEAMS_NEW_PASSWORD` | no | New password for `rotate-password`; unset = hidden prompt, typed twice |
| `MEETING_LINK` | for `create-bot` | A `teams.microsoft.com` meeting link |
| `SIGN_IN_EMAIL` | no | Pin one account (`create-bot`, `verify`) |
| `STRICT_EMAIL` | no | API default `true`; only matters with `SIGN_IN_EMAIL` |
| `BOT_NAME` / `BOT_IMAGE_URL` | no | Only shown if the bot joins as a guest; a signed-in Teams bot uses the Microsoft account's name and picture, and the CLI warns if `BOT_IMAGE_URL` is set |
| `VIDEO_REQUIRED` | no | Video is off by default; `true` records video as well as audio. Default `false`. |
| `VIDEO_LAYOUT` | no | Only read when `VIDEO_REQUIRED=true`. `speaker_view` (the default) or `grid_view`. The API default is `grid_view`, so speaker view is always sent explicitly. |
| `WAITING_ROOM_TIMEOUT` | no | Lobby wait in seconds, 60-1800 on Teams (default `600`) |
| `CALLBACK_URL` | no | Per-bot webhook URL for lifecycle events |
| `DEBUG` | no | Set to anything to print stack traces on unexpected errors |

**Passwords** are only read from environment variables or a no-echo prompt. They are never accepted as CLI flags (they would land in shell history), never printed, redacted as `[redacted]` in `--dry-run` output, and scrubbed out of any API error message. The API never returns them.

---

## Setup, step by step

### 1. Prepare Microsoft 365

Work through the checklist above. Nothing in MeetStream will work until the accounts can sign in to Teams on their own without prompts.

### 2. Register the login domain

```bash
node index.js register-domain
```

`POST /teams-login-domains` with:

```json
{ "domain": "bots.acme.com", "name": "Acme Teams bots", "login_mode": "always" }
```

`login_mode` is always `"always"`: `"if_required"` is not supported for Teams yet, and the CLI refuses it rather than sending it. If the domain is already registered on this key, the command says so and does nothing.

### 3. Register the bot accounts

```bash
node index.js add-accounts
```

For each email in `TEAMS_BOT_ACCOUNTS`, `POST /teams-logins` with `{ domain, email, password }`. All passwords are collected before the first call, so a missing one fails the run up front. Emails already registered under the domain are skipped with a pointer to `rotate-password`.

### 4. Check accounts and leases

```bash
node index.js status                  # every domain on this key
node index.js status --domain bots.acme.com --json
```

Shows each account's `login_id`, `is_active`, `lease_status`, `last_session_result` and `last_login_error`, plus how many bots the domain can run at once and how many accounts are free right now.

### 5. Pre-flight

```bash
node index.js verify
```

Read-only. Fails if the domain is not registered, has no active accounts, if `SIGN_IN_EMAIL` is not registered, or if it is busy while `strict_email` is on. Warns when no account is free at the moment.

### 6. Send a signed-in bot

```bash
node index.js create-bot
```

```json
{
  "meeting_link": "https://teams.microsoft.com/l/meetup-join/...",
  "video_required": false,
  "teams": {
    "login_required": true,
    "teams_login_domain": "bots.acme.com",
    "sign_in_email": "bot1@bots.acme.com",
    "strict_email": false
  }
}
```

| Field | Meaning |
| --- | --- |
| `login_required` | `true` turns on signed-in mode. Omit the block for a normal guest bot. |
| `teams_login_domain` | The registered login domain. Required. |
| `sign_in_email` | Optional. Pin one account. Omit and MeetStream picks any free one. |
| `strict_email` | Optional, default `true`. With `sign_in_email`: `true` fails if that account is busy or unhealthy, `false` falls back to any available account in the domain. |

**A malformed `teams` block is dropped silently and the bot joins as a guest.** That is why the CLI validates the block before sending it (domain, email, link host, timeout range). If a bot ever appears under `bot_name` instead of the Microsoft account's name, the block was not applied.

`setup` runs steps 2-4 in one go, and step 6 too if `MEETING_LINK` is set.

---

## What you should see

`node index.js setup` (or the individual commands) prints plain text, one block per step. A first-time run with two accounts looks like this:

```
== 1. Register the login domain
Domain registered.
{
  "domain": "bots.acme.com",
  "name": "Acme Teams bots",
  "login_mode": "always",
  "created_at": "2026-09-18T10:02:11Z"
}

Next: node index.js add-accounts

== 2. Register the bot accounts
added bot1@bots.acme.com  login_id=<login_id>  lease_status=available  (password from TEAMS_BOT_PASSWORD_1)
added bot2@bots.acme.com  login_id=<login_id>  lease_status=available  (password from TEAMS_BOT_PASSWORD_2)

2 added, 0 skipped, 0 failed.
Remember: one account runs one bot at a time. Check leases with: node index.js status

== 3. Accounts and lease status

bots.acme.com
  name        Acme Teams bots
  login_mode  always
  created_at  2026-09-18T10:02:11Z
  2 account(s), 2 active = up to 2 concurrent signed-in bot(s). Free right now: 2.
  bot1@bots.acme.com
    login_id             <login_id>
    is_active            true
    lease_status         available
    last_session_result  -
  bot2@bots.acme.com
    ...

Set MEETING_LINK and run "node index.js create-bot" to send a signed-in bot.
```

Re-running is safe: the domain step prints `Domain "bots.acme.com" is already registered on this API key (login_mode=always).` and each known email prints `skip  bot1@bots.acme.com is already registered (login_id=...)`.

`node index.js verify` prints one `OK` / `WARN` / `FAIL` line per check, for example `OK    domain "bots.acme.com" is registered.` followed by `OK    SIGN_IN_EMAIL "bot1@bots.acme.com" is active and free.`

`node index.js create-bot` prints the request body it is about to send, then:

```
Bot created.
{
  "bot_id": "<bot_id>",
  ...
}

That account is now leased to this bot until it leaves; it cannot run a second bot meanwhile.
Watch progress with GET /bots/{bot_id}/status. If the bot shows up as a guest under
bot_name, the teams block was not applied: compare it with the request above.
```

In the meeting the bot appears under the Microsoft account's display name and picture, not `bot_name`. With `--dry-run` every command instead prints `[dry-run] <METHOD> <URL>` plus the redacted body (see below) and exits 0.

---

## Managing accounts

`<login>` is an email or a `login_id`. An email is looked up with `GET /teams-logins?domain=`.

```bash
node index.js rotate-password bot1@bots.acme.com   # PATCH { password }, reactivates a deactivated account
node index.js disable bot1@bots.acme.com           # PATCH { is_active: false }
node index.js enable bot1@bots.acme.com            # PATCH { is_active: true }
node index.js remove-account bot1@bots.acme.com    # DELETE, asks you to type the email back
node index.js rename-domain bots.acme.com --name "New label"
node index.js remove-domain bots.acme.com          # DELETE, cascades to every account, asks you to type the domain
```

`rotate-password` only changes the copy MeetStream signs in with. Change the password in Microsoft 365 first, then run it straight away.

Removals show what is about to be deleted and require typing the email or domain back, like the `delete-bot-data` template. Without a terminal they refuse; `--force` skips the prompt.

### Dry run

Add `--dry-run` to any command. Nothing is sent and no API key is needed; each request prints as method, URL and body, with passwords shown as `[redacted]`. Reads return nothing in a dry run, so lookups by email show a `<login_id of ...>` placeholder.

```
[dry-run] POST https://api.meetstream.ai/api/v1/teams-logins
          {
            "domain": "bots.acme.com",
            "email": "bot1@bots.acme.com",
            "password": "[redacted]"
          }
          (password from TEAMS_BOT_PASSWORD_1)
```

---

## How it works

```
index.js          CLI router: checklist | setup | register-domain | add-accounts | status | verify
                  | rotate-password | enable | disable | remove-account | rename-domain
                  | remove-domain | create-bot
src/client.js     fetch wrapper: Token auth, 202 pending, 507 replay, backoff, --dry-run, password redaction
src/cli.js        argv parsing, typed confirmation, no-echo password prompt
src/checklist.js  the Microsoft 365 prerequisites text
src/accounts.js   TEAMS_BOT_ACCOUNTS / TEAMS_BOT_PASSWORD_<n> / TEAMS_NEW_PASSWORD
src/domains.js    /teams-login-domains
src/logins.js     /teams-logins, email -> login_id lookup
src/bot.js        create_bot with the teams block, validated locally
src/errors.js     documented status codes -> what to do next
```

`create_bot` is sent with an `Idempotency-Key` and is not retried on 429: for a signed-in Teams bot that status means every account is busy, which a few seconds of backoff will not fix.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `400` from `create_bot`: `teams.teams_login_domain '...' is not registered` | The domain is not registered on this API key | `node index.js register-domain`, then `add-accounts` |
| `403` | The domain or account belongs to a different MeetStream account (or the key is not valid for this workspace) | Use the API key of the account that registered it, or register a domain you own |
| `404` from `create_bot` | `sign_in_email` is not registered under the domain | `node index.js status`, then `add-accounts` |
| `404` from the login endpoints | Domain not registered, or no such `login_id` | `node index.js status` |
| `409` from `create_bot` | The pinned account is busy or deactivated with `strict_email` true, or no account is both active and free | Set `STRICT_EMAIL=false`, reactivate with `rotate-password` or `enable`, wait, or add accounts |
| `429` from `create_bot` | All Teams accounts in the domain are in use | One account = one bot. Wait, or register more accounts |
| Bot joined as a guest under `bot_name` | The `teams` block was malformed and dropped silently | Compare with the request the CLI printed; run `--dry-run` |
| Bot shows the "wrong" name or picture | Expected: the Microsoft account's profile is used | Change the display name and photo on the Microsoft 365 user |
| Account `is_active: false` with a `last_login_error` | Sign-in failed, usually a changed or expired password, or an MFA / "more information required" prompt | Fix it in Microsoft 365 (checklist items 3-5), then `rotate-password` |
| `teams.live.com is Teams for personal use` | Consumer Teams meeting | Use a work or school Teams meeting |
| Bot still waits in the lobby | Admission is still governed by the meeting organiser's lobby settings; a bot account from your own tenant is an external user to other organisations | Admit it, or adjust the meeting's lobby options. Raise `WAITING_ROOM_TIMEOUT` (max 1800) |
| `401` | No API key sent | Header must be `Authorization: Token <key>` |
| `Configuration error: Missing required environment variable MEETSTREAM_API_KEY` | `.env` missing or the key is blank | `cp .env.example .env` and fill it in. Only `--dry-run` runs without a key |
| `Configuration error: TEAMS_BOT_ACCOUNTS ...` / `No password for <email>` / `The two passwords did not match. Nothing changed.` | Bad account list, or a password was missing or mistyped at the hidden prompt | Fix `TEAMS_BOT_ACCOUNTS` / `TEAMS_BOT_PASSWORD_<n>`, or re-run and type the password again |
| `MeetStream 429 on ...` or `MeetStream 5xx on ...` after several seconds | Rate limit or transient server error on the login endpoints | The client already retried 3 times with backoff; wait a moment and re-run. On `create_bot` a 429 is not retried because it means every account is busy |
| `Network error calling <METHOD> <path>: ...` | DNS, connection or 30 s timeout failure, retried 3 times | Check connectivity and `MEETSTREAM_BASE_URL` |
| `Domain already registered (507 replay).` / `ok    (507 replay)` / `Idempotent replay (507) - the bot already exists.` | An `Idempotency-Key` you already used | Not an error: the original request succeeded and its result was returned |
| `FAIL  every account is inactive; create_bot would return 409.` (`verify`) | All accounts were deactivated after failed sign-ins | `node index.js status` for `last_login_error`, fix it in Microsoft 365, then `rotate-password` |
| `WARN  no account is free right now; create_bot would return 409 or 429 until one is.` | Every account is leased to a running bot | Wait for a bot to leave, or `add-accounts` |
| `Not an interactive terminal, so the confirmation prompt cannot run.` | `remove-account` / `remove-domain` run from a script or CI | Run it in a terminal, or add `--force` if you are certain |
| `Not confirmed. Nothing was deleted.` | The typed email or domain did not match | Type it back exactly as shown |

---

## Related

- [Teams signed-in bots guide](https://docs.meetstream.ai/guides/app-integrations/teams-signed-in-bots)
- [Microsoft Teams platform guide](https://docs.meetstream.ai/guides/platforms/microsoft-teams)
- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [Automatic leave configuration](https://docs.meetstream.ai/guides/features/automatic-leave-configuration)
- [Error codes](https://docs.meetstream.ai/errors)
- Related templates: [../teams-meeting-bot](../teams-meeting-bot) (Teams lifecycle, lobby and timeout behaviour for guest bots); [../google-signed-in-bots-setup](../google-signed-in-bots-setup) and [../google-login-management](../google-login-management) (the Google Meet equivalent)
