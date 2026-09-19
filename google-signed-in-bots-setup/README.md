# Set Up Google Signed-In Meet Bots with the MeetStream API

Set up MeetStream Google signed-in bots end to end, so a meeting bot joins Google Meet logged into a real Google Workspace account instead of as an anonymous guest, and skips the lobby when that account is on the invite. Covers the Workspace SAML SSO profile, the certificate pair, the domain registration call, and a `create_bot` request with `google_meet.login_required`. Google Meet only; Zoom and Microsoft Teams have their own signed-in flows.

```bash
npm install
cp .env.example .env      # fill in MEETSTREAM_API_KEY and your domain
node index.js             # prints the full checklist
```

## Prerequisites

- Node.js 18 or newer (uses the built-in `fetch`).
- A MeetStream API key from [app.meetstream.ai](https://app.meetstream.ai), set as `MEETSTREAM_API_KEY`. Only `gen-cert` and the checklist run without it.
- `openssl` on your PATH (`gen-cert` shells out to it; macOS `brew install openssl`, Debian/Ubuntu `apt-get install openssl`).
- A **Google Workspace** tenant on a custom domain (for example `yourcompany.com`). A personal `@gmail.com` account cannot do this: the setup is a Workspace admin SSO profile.
- **Super-admin access** to the Google Workspace Admin Console (`admin.google.com`) to enable the legacy SSO profile and upload the certificate (steps 1 to 4 below).
- One or more real Google Workspace users on that domain to act as bot accounts; each one is added as a login in the MeetStream dashboard with its own certificate upload (step 8).
- A `meet.google.com` link for `create-bot`; other platforms are rejected before any request is made.
- Only if you set `CALLBACK_URL`: a public HTTPS URL MeetStream can reach (see [webhook-local-tunnel](../webhook-local-tunnel)). This template never waits for the bot itself.

---

## What a signed-in bot is

By default a MeetStream bot joins Google Meet **anonymously**, which means Meet's admission rules apply: with Host management on, only the host and co-hosts can see and admit it, and if nobody does it leaves when `waiting_room_timeout` expires.

A **signed-in bot** logs into a real Google Workspace account before joining. It appears as a named participant with that account's display name and avatar, and if the account's email is on the calendar invite, Meet treats it as an invited participant and it **skips the lobby entirely**.

Use it when:

- The meeting or Workspace policy blocks anonymous participants.
- Meetings start without a host available to admit a guest.
- You want a verified name and avatar instead of "Unknown".

This is a **Google Meet only** feature. Zoom and Teams bots ignore the `google_meet` block. For Teams see [teams-signed-in-bots-setup](../teams-signed-in-bots-setup); for Zoom see [zoom-authenticated-joins](../zoom-authenticated-joins).

---

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/google-signed-in-bots-setup
npm install
cp .env.example .env      # fill in MEETSTREAM_API_KEY and GOOGLE_LOGIN_DOMAIN
node index.js             # checklist
node index.js gen-cert    # then follow "Configuration, step by step" below
```

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `MEETSTREAM_API_KEY` | yes (except `gen-cert`) | API key, sent as `Authorization: Token <key>`. |
| `MEETSTREAM_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |
| `CERT_DIR` | no | Where `gen-cert` writes `key.pem` and `cert.pem`. Default `./certs`. |
| `CERT_SUBJECT` | no | OpenSSL subject, e.g. `/CN=yourdomain.com/O=Your Company/C=US`. Unset: openssl prompts interactively. |
| `CERT_DAYS` | no | Certificate validity in days. Default `3650`. |
| `GOOGLE_DOMAIN_USER_ID` | `register-domain` | `user_id` body field of `POST /google-login-domains`. |
| `GOOGLE_DOMAIN_NAME` | `register-domain` | `name` body field, a label for the entry. |
| `GOOGLE_LOGIN_MODE` | no | `always` or `if_required`. Unset: API default. |
| `GOOGLE_LOGIN_DOMAIN` | `verify`, `create-bot` | The Workspace domain you configured. Goes into `google_meet.google_login_domain`. |
| `SIGN_IN_EMAIL` | no | Pin one login under the domain. Unset: MeetStream picks one round-robin. |
| `STRICT_EMAIL` | no | With `SIGN_IN_EMAIL` only. API default `true`: fail if that account is busy or unhealthy. `false`: fall back to any available login in the domain. |
| `MEETING_LINK` | `create-bot` | The `meet.google.com` link to join. |
| `BOT_NAME` | no | Sent as `bot_name`. Meet shows the Google account's own name, not this. Default `MeetStream Signed-In Bot`. |
| `VIDEO_REQUIRED` | no | `true` records video as well as audio. Default `false`. |
| `WAITING_ROOM_TIMEOUT` | no | `automatic_leave.waiting_room_timeout`, 60-600 seconds. Unset: API default 600. |
| `CALLBACK_URL` | no | Per-bot webhook URL for lifecycle events. |
| `DEBUG` | no | Set to any value to print full stack traces on unexpected errors. |

---

## What you should see

`node index.js gen-cert`:

```text
Using OpenSSL 3.x.x

Generated a 3650-day self-signed pair:
  private key : /path/to/labs/google-signed-in-bots-setup/certs/key.pem  (chmod 600 - keep this out of git)
  certificate : /path/to/labs/google-signed-in-bots-setup/certs/cert.pem

Upload BOTH files in the MeetStream dashboard under Integrations -> Google Signed-In Bots,
once for every mail ID you add under the domain. Upload the certificate to your Google
Workspace legacy SSO profile as well ("Verification certificate").
```

`node index.js status`, once a domain and two logins exist:

```text
Configured domains (1):
  yourdomain.com  name=Acme-SSO  login_mode=always  logins=2 (active 2)  max_concurrent_per_login=20

Logins (2):
  bot@yourdomain.com  id=<login_id>  active=true  sessions=0  last_test=success
  bot2@yourdomain.com  id=<login_id>  active=true  sessions=3  last_test=success
```

`node index.js verify` with `SIGN_IN_EMAIL` set, when everything is in place (exit code 0):

```text
OK    domain "yourdomain.com" is configured.
      login_mode=always
      2 login(s) attached.
        bot@yourdomain.com  active=true  sessions=0  last_test=success
        bot2@yourdomain.com  active=true  sessions=3  last_test=success
OK    SIGN_IN_EMAIL "bot@yourdomain.com" is an active login.

Reminder: add bot@yourdomain.com to the Google Calendar invite so Meet treats the bot as an
invited participant and lets it bypass the lobby.
```

When it is not, `verify` prints one `FAIL` line and exits 1, for example `FAIL  "yourdomain.com" is not configured on this API key. Run "node index.js status" to see what is, or add it in the dashboard.`

`node index.js create-bot` echoes the exact body it sent, then the API response:

```text
Request sent:
{
  "meeting_link": "https://meet.google.com/xxx-xxxx-xxx",
  "bot_name": "MeetStream Signed-In Bot",
  "video_required": false,
  "google_meet": {
    "login_required": true,
    "google_login_domain": "yourdomain.com",
    "sign_in_email": "bot@yourdomain.com"
  }
}

Bot created.
{
  "bot_id": "<bot_id>",
  ...
}

The bot signs in with the Google account, so Meet shows that account's name and avatar -
not bot_name. Watch its progress with GET /bots/{bot_id}/status.
```

`strict_email` appears in the body only when `STRICT_EMAIL` is set. On an idempotent replay the middle line reads `Idempotent replay (507) - the bot already exists.` Any API failure prints `MeetStream <status> on <path>: <API message>` and exits 1.

---

## Configuration, step by step

This is a one-time setup per domain. Steps 1-4 happen in Google, step 5 on your machine, steps 6-8 in MeetStream.

### 1. Open the Google Workspace Admin Console

Go to [admin.google.com](https://admin.google.com) and sign in as a super admin of the domain you want the bot accounts to live on.

### 2. Find the SSO settings

Navigate to **Security -> Authentication -> SSO with third-party IdPs**.

### 3. Open the legacy SSO profile

On that page, select **SSO with third-party IdPs**, then open **Legacy SSO profile**.

> This is deliberately the *legacy* profile, not a new SAML profile. MeetStream's sign-in flow is wired to the legacy endpoints below.

### 4. Enable it and fill in the MeetStream URLs

Turn on **Enable legacy SSO profile** and set:

| Field | Value |
| --- | --- |
| Sign-in page URL | `https://api.meetstream.ai/api/v1/bot/gmeet-sign-in` |
| Sign-out page URL | `https://api.meetstream.ai/api/v1/bot/gmeet-sign-out` |

On the same page, also enable **Domain-specific issuer**.

Leave the page open - you will come back to upload the verification certificate you generate next.

### 5. Generate the certificate pair

```bash
node index.js gen-cert
```

That runs exactly the documented OpenSSL command:

```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -sha256 -days 3650 -nodes
```

It writes two files into `CERT_DIR` (default `./certs`):

- `key.pem` - the private key. The script `chmod 600`s it. It is gitignored. Do not share it.
- `cert.pem` - the public certificate.

Set `CERT_SUBJECT` in `.env` (for example `/CN=yourcompany.com/O=Your Company/C=US`) to skip OpenSSL's interactive prompts. Re-running is refused if the files already exist; pass `--force` if you really want to replace them.

> If you regenerate the pair later, you must re-upload it in **both** places - Google Workspace and MeetStream - or sign-in breaks.

Upload `cert.pem` as the verification certificate on the Google legacy SSO profile page from step 4, and save.

### 6. Open the MeetStream integration

In the [MeetStream dashboard](https://app.meetstream.ai/integrations), go to **Integrations -> Google Signed-In Bots**.

### 7. Add your domain

Enter the custom domain used by your Google Workspace account, for example `yourcompany.com`.

You can also create the domain entry from the API:

```bash
node index.js register-domain
```

That issues `POST /google-login-domains` with the documented body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `user_id` | string | yes | from `GOOGLE_DOMAIN_USER_ID` |
| `name` | string | yes | a label for the entry, from `GOOGLE_DOMAIN_NAME` |
| `login_mode` | enum | no | `always` or `if_required`, from `GOOGLE_LOGIN_MODE` |

The response echoes `sso_workspace_domain`, `name`, `login_mode`, `max_concurrent_per_login` and `created_at`. The dashboard is the primary supported path for this step; the API endpoint exists for automation. See the [API reference](https://docs.meetstream.ai/api-reference/api-endpoints/google-signed-in-bots/create-google-domain) for the current contract.

### 8. Add mail IDs and upload the certificates

Under the domain, add **each email address you will use to invite the bot**. For every email you add, upload `key.pem` **and** `cert.pem` from step 5.

The certificate has to be uploaded again each time you add a new mail ID under the domain - it is per login, not per domain.

Each of these mail IDs must be a real Google Workspace user on that domain.

### 9. Verify before you send a real bot

```bash
node index.js status    # every domain + every login on this API key
node index.js verify    # checks GOOGLE_LOGIN_DOMAIN and SIGN_IN_EMAIL specifically
```

`verify` fails loudly if the domain is not registered, has no logins, or if `SIGN_IN_EMAIL` is not an active login under it. `GET /google-login-domains/{domain}` also returns each login's `is_active`, `active_sessions`, and `last_test_status`, which is the fastest way to spot a login that never authenticated.

---

## Sending the bot

```bash
node index.js create-bot
```

The signed-in switch is the `google_meet` block on `POST /bots/create_bot`:

```json
{
  "meeting_link": "https://meet.google.com/abc-defg-hij",
  "bot_name": "Meeting Assistant",
  "video_required": false,
  "google_meet": {
    "login_required": true,
    "google_login_domain": "yourdomain.com",
    "sign_in_email": "bot@yourdomain.com",
    "strict_email": true
  }
}
```

| Field | Meaning |
| --- | --- |
| `login_required` | `true` turns on signed-in mode. Omit the whole block for a normal anonymous bot. |
| `google_login_domain` | The domain you configured in step 7. Required when `login_required` is true. |
| `sign_in_email` | Optional. Pin one specific login. Omit and MeetStream distributes bots across the domain's logins round-robin. |
| `strict_email` | Optional, only with `sign_in_email`. Default `true`: fail if that account is busy or unhealthy. `false`: fall back to any available login in the domain. |

**Add `sign_in_email` to the Google Calendar invite.** That is what makes Meet treat the bot as an invited participant and skip the lobby. Signing in alone gets you a named participant; being on the invite gets you past the waiting room.

Two things worth knowing:

- The visible participant name and avatar come from the **Google account**, not from `bot_name`.
- Anonymous and signed-in bots coexist fine on the same API key. Include the `google_meet` block only for the meetings that need it.

---

## How many logins do I need?

Google enforces concurrency limits on how many meetings a single account can join at once. MeetStream distributes signed-in bots across a domain's logins round-robin.

```
logins = peak concurrent Google Meet sessions / 20
```

Round up, and leave headroom for spikes. A peak of 100 concurrent Meet bots means at least 5 logins. Each login needs its own certificate upload (step 8).

`node index.js status` shows `login_count`, `active_login_count`, and per-login `active_sessions` so you can see how close you are to saturating them. For day-to-day CRUD on domains and logins, see the [google-login-management](../google-login-management) template.

---

## How it works

```
index.js          CLI: gen-cert | register-domain | status | verify | create-bot
src/client.js     fetch wrapper - Token auth, 202 pending, 507 replay, backoff on 429/5xx
src/certs.js      wraps the openssl command, refuses to clobber an existing pair
src/domains.js    /google-login-domains and /google-logins reads and writes
src/bot.js        create_bot with the google_meet block
```

Nothing in `src/certs.js` transmits the key material - the pair is generated locally and you upload it yourself.

There are no wait or poll loops here: every command is one request and exits, and `create-bot` does not wait for the bot to join (use [bot-status-monitor](../bot-status-monitor) for that; its polling is capped). The only retry is inside `src/client.js` and it is bounded: one try plus 3 retries (4 calls in all), only on 429, 5xx or a network error, backoff of 1, 2 and 4 seconds, then `Gave up on <METHOD> <path> after 4 attempts: <API message>`. A 202 is reported as pending, never polled.

---

## Troubleshooting

Every API failure is printed as `MeetStream <status> on <path>: <message>`, where `<message>` is the API's own `message` field.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Configuration error: Missing required environment variable MEETSTREAM_API_KEY` | No `.env`, or an empty key. Only `gen-cert` and the checklist run without it. Checked before any request. | `cp .env.example .env` and paste your key. |
| `Configuration error: MEETSTREAM_API_KEY still has the placeholder value from .env.example` | `.env` was copied but not edited. | Paste your real key. |
| `Configuration error: register-domain needs GOOGLE_DOMAIN_USER_ID and GOOGLE_DOMAIN_NAME` / `verify needs GOOGLE_LOGIN_DOMAIN` / `create-bot needs MEETING_LINK and GOOGLE_LOGIN_DOMAIN` | That command's variables are blank. | Fill them in `.env` (see the table above). |
| `Configuration error: WAITING_ROOM_TIMEOUT must be between 60 and 600` / `CERT_DAYS must be an integer` | Out-of-range or non-numeric setting. | Fix the value. |
| `MeetStream 401 on ...` / `MeetStream 403 on ...` | 401: no key was sent. 403: the key is not valid for this workspace, or the domain or login belongs to another MeetStream account. | The header must be `Authorization: Token <key>`; regenerate the key if 403 persists. |
| `FAIL  "yourdomain.com" is not configured on this API key` (`verify`, 404) | The domain is registered against a different API key or workspace, or was never added. | Run `node index.js status` to see what this key actually has, then add it in the dashboard or with `register-domain`. |
| `FAIL  no logins under this domain` / `FAIL  SIGN_IN_EMAIL "..." is not one of the logins under this domain` / `FAIL  login "..." exists but is_active=false` | `verify` found the domain but no usable account for the bot. Exit code 1. | Add the mail ID under the domain in the dashboard with its certificate, or reactivate it. |
| `MeetStream 400 on /bots/create_bot: ...` | `google_login_domain` missing while `login_required` is true, `waiting_room_timeout` outside 60-600, or a bad `meeting_link`. | Set `GOOGLE_LOGIN_DOMAIN`; check the timeout and the link. |
| `MeetStream 400 on /google-login-domains: ...` (`register-domain`) | Missing `user_id` or `name`, or `login_mode` not `always` / `if_required`. | Check `GOOGLE_DOMAIN_USER_ID`, `GOOGLE_DOMAIN_NAME`, `GOOGLE_LOGIN_MODE`. |
| `MeetStream 404 on /bots/create_bot: ...` | `SIGN_IN_EMAIL` is not a login registered under `GOOGLE_LOGIN_DOMAIN`. | Run `verify` first; it catches this before the bot is created. |
| `MeetStream 409 on /bots/create_bot: ...` | The pinned `SIGN_IN_EMAIL` is busy or deactivated and `STRICT_EMAIL` is `true` (the default). | Wait, pick another login, or set `STRICT_EMAIL=false` to fall back to any free login in the domain. |
| `MeetStream 429 on /bots/create_bot: ...` after 3 retries | Every login in the domain is in use, or you are rate limited. | Add logins (see "How many logins do I need?") or wait. |
| `Gave up on POST /bots/create_bot after 4 attempts: MeetStream 503 ...` | 5xx or network failure on every retry. | Re-run; check your network if it persists. |
| `Idempotent replay (507) - the bot already exists.` | The same `Idempotency-Key` was seen before. Treated as success. | Nothing to fix. |
| `create_bot answered 200 but returned no bot_id` | The API answered 2xx with an unexpected body. | Check the printed body; retry with a fresh run. |
| `openssl was not found on your PATH` | `gen-cert` needs the OpenSSL CLI. | macOS `brew install openssl`, Debian/Ubuntu `apt-get install openssl`. |
| `openssl failed to generate the key pair: ...` | Bad `CERT_SUBJECT` or an unwritable `CERT_DIR`. | Use the `/CN=.../O=.../C=..` form; check permissions. |
| `Unknown command "..."` | Typo. | Commands: `gen-cert`, `register-domain`, `status`, `verify`, `create-bot`. |
| `"..." is not a meet.google.com link` | Signed-in bots are Google Meet only. | Use a `meet.google.com` link, or the Teams / Zoom templates for those platforms. |
| Bot still lands in the waiting room | Signing in is not the same as being invited. | Add the exact `sign_in_email` address to the calendar event. Also confirm the host has not restricted meeting access to a narrower group. |
| Bot shows the wrong name | Expected: Google Meet renders the signed-in account's display name and avatar. | Change the Google account's profile, not `bot_name`. |
| `bot.stopped` with `bot_event: bot.notallowed` | The bot waited and was never admitted before `waiting_room_timeout`. `bot.denied` means a host explicitly rejected it. | See [gmeet-lobby-handling](../gmeet-lobby-handling) for a webhook handler that distinguishes and reacts to both. |
| A login shows `last_test_status` other than success | The SSO profile or the certificate for that mail ID is wrong. | Re-check step 4 (both URLs plus domain-specific issuer) and re-upload `cert.pem` / `key.pem` for that login. |
| `key.pem or cert.pem already exists` | `gen-cert` refuses to overwrite a pair that may already be uploaded. | Pass `--force` only if you will re-upload on both sides, or change `CERT_DIR`. |

---

## Related

- [Google Signed-In Bots](https://docs.meetstream.ai/guides/app-integrations/google-signed-in-bots)
- [Google Meet Lobby and Admission](https://docs.meetstream.ai/guides/app-integrations/gmeet-lobby-admission)
- [Google Meet Bots](https://docs.meetstream.ai/guides/platforms/google-meet)
- [Create Google domain](https://docs.meetstream.ai/api-reference/api-endpoints/google-signed-in-bots/create-google-domain)
- [List Google logins](https://docs.meetstream.ai/api-reference/api-endpoints/google-signed-in-bots/list-google-logins)
- [Create Bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [Automatic leave configuration](https://docs.meetstream.ai/guides/features/automatic-leave-configuration)
- Sibling templates: [google-login-management](../google-login-management), [gmeet-lobby-handling](../gmeet-lobby-handling), [teams-signed-in-bots-setup](../teams-signed-in-bots-setup), [zoom-authenticated-joins](../zoom-authenticated-joins)
