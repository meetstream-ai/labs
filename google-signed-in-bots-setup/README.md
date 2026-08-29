# Google Signed-In Bots - Setup

Set up MeetStream Google signed-in bots end to end: the Google Workspace SAML SSO profile, the certificate pair, the domain registration call, and a `create_bot` request with `google_meet.login_required`.

```bash
npm install
cp .env.example .env      # fill in MEETSTREAM_API_KEY and your domain
node index.js             # prints the full checklist
```

---

## What a signed-in bot is

By default a MeetStream bot joins Google Meet **anonymously**, which means Meet's admission rules apply: with Host management on, only the host and co-hosts can see and admit it, and if nobody does it leaves when `waiting_room_timeout` expires.

A **signed-in bot** logs into a real Google Workspace account before joining. It appears as a named participant with that account's display name and avatar, and if the account's email is on the calendar invite, Meet treats it as an invited participant and it **skips the lobby entirely**.

Use it when:

- The meeting or Workspace policy blocks anonymous participants.
- Meetings start without a host available to admit a guest.
- You want a verified name and avatar instead of "Unknown".

This is a **Google Meet only** feature. Zoom and Teams bots ignore the `google_meet` block.

---

## Prerequisites

- Node 18+
- A **Google Workspace** account on a custom domain (for example `yourcompany.com`). A personal `@gmail.com` account cannot do this - the setup is a Workspace admin SSO profile.
- **Super-admin access** to the Google Workspace Admin Console (`admin.google.com`).
- `openssl` on your PATH.
- A MeetStream API key from [app.meetstream.ai](https://app.meetstream.ai).

---

## Setup, step by step

This is a one-time setup per domain. Steps 1-4 happen in Google, step 5 on your machine, steps 6-8 in MeetStream.

### 1. Open the Google Workspace Admin Console

Go to [admin.google.com](https://admin.google.com) and sign in as a super admin of the domain you want the bot accounts to live on.

### 2. Find the SSO settings

Navigate to **Security → Authentication → SSO with third-party IdPs**.

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

In the [MeetStream dashboard](https://app.meetstream.ai/integrations), go to **Integrations → Google Signed-In Bots**.

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
| `google_login_domain` | The domain you configured in step 7. Required. |
| `sign_in_email` | Optional. Pin one specific login. Omit and MeetStream distributes bots across the domain's logins round-robin. |
| `strict_email` | Optional. Fail rather than silently fall back to another login. |

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

`node index.js status` shows `login_count`, `active_login_count`, and per-login `active_sessions` so you can see how close you are to saturating them. For day-to-day CRUD on domains and logins, see the `google-login-management` template.

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

---

## Troubleshooting

**`verify` says the domain is not configured (404)**
The domain is registered against a different API key or workspace, or was never added. Run `node index.js status` to see what this key actually has.

**Bot still lands in the waiting room**
Signing in is not the same as being invited. Add the exact `sign_in_email` address to the calendar event. Also confirm the host has not restricted meeting access to a narrower group.

**Bot shows the wrong name**
Expected - Google Meet renders the signed-in account's display name and avatar. Change the Google account's profile, not `bot_name`.

**`bot.notallowed` / `bot_status: "NotAllowed"`**
The bot waited and was never admitted before `waiting_room_timeout`. **`Denied`** means a host explicitly rejected it. See the `gmeet-lobby-handling` template for a webhook handler that distinguishes and reacts to both.

**A login shows `last_test_status` other than success**
The SSO profile or the certificate for that mail ID is wrong. Re-check step 4 (both URLs plus domain-specific issuer) and re-upload `cert.pem` / `key.pem` for that login.

**401 / 403 from the API**
401 means no key was sent, 403 means the key is not valid for this workspace. The header must be `Authorization: Token <key>`.

---

## Docs

- [Google Signed-In Bots](https://docs.meetstream.ai/guides/app-integrations/google-signed-in-bots)
- [Google Meet Lobby & Admission](https://docs.meetstream.ai/guides/app-integrations/gmeet-lobby-admission)
- [Google Meet Bots](https://docs.meetstream.ai/guides/platforms/google-meet)
- [Google signed-in bot API reference](https://docs.meetstream.ai/api-reference/api-endpoints/google-signed-in-bots/create-google-domain)
- [Create Bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
