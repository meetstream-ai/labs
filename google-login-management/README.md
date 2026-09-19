# Manage Google Signed-In Bot Logins with the MeetStream API

Admin CLI for MeetStream Google signed-in meeting bots on Google Meet: list, add, update and delete **domains** (`/google-login-domains`) and **logins** (`/google-logins`) with the MeetStream API, plus a capacity planner that tells you how many Google Workspace logins your peak concurrent Meet sessions need.

```bash
npm install
cp .env.example .env      # fill in MEETSTREAM_API_KEY
node index.js             # prints the command list
```

If you have not set up signed-in bots yet, start with [../google-signed-in-bots-setup](../google-signed-in-bots-setup); this one assumes the Workspace SSO profile already exists.

## Prerequisites

- Node.js 18 or newer (built-in `fetch`)
- A MeetStream API key from <https://app.meetstream.ai>
- A Google Workspace SSO profile registered with MeetStream (dashboard: **Integrations > Google Signed-In Bots**)

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/google-login-management
npm install
cp .env.example .env      # then fill in MEETSTREAM_API_KEY
node index.js domains list
```

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes (not for `plan`) | API key, sent as `Authorization: Token <key>` |
| `MEETSTREAM_BASE_URL` | no | API base URL (default `https://api.meetstream.ai/api/v1`) |
| `PEAK_CONCURRENT_MEET_SESSIONS` | no | Default `--peak` for `capacity` and `plan` |

---

## Commands

### Domains

```bash
node index.js domains list
node index.js domains get yourdomain.com
node index.js domains add --user-id <id> --name Acme-SSO [--login-mode always]
node index.js domains update yourdomain.com --set name=Acme-Prod
node index.js domains update yourdomain.com --payload patch.json
node index.js domains delete yourdomain.com [--yes]
```

`domains get` also prints every login attached to that domain, with `is_active`, `active_sessions`, and `last_test_status` - the fastest way to spot a login that never authenticated.

### Logins

```bash
node index.js logins list
node index.js logins list --domain yourdomain.com
node index.js logins add --payload body.json
node index.js logins add --field email=bot@acme.com --file cert=./cert.pem --file key=./key.pem
node index.js logins update <login_id> --set is_active=false
node index.js logins delete <login_id> [--yes]
```

`logins list --domain X` reads `GET /google-login-domains/{domain}` and pulls the `logins` array out of it, which also gives you the domain record. `GET /google-logins?domain=X` returns the same filtered list if you only want the logins. There is no `GET /google-logins/{login_id}`; read one login through its domain.

### Capacity

```bash
node index.js capacity --peak 100                    # compares the plan against live logins
node index.js capacity --peak 100 --headroom 0.25
node index.js capacity --peak 100 --domain yourdomain.com
node index.js plan --peak 100                        # pure math, no API call, no key needed
```

### Global flags

| Flag | Effect |
| --- | --- |
| `--json` | print the raw API response instead of the formatted view |
| `--yes` | skip the interactive confirmation on deletes |
| `--set key=value` | build a PATCH body; repeatable. `key:=value` forces a string |
| `--payload file.json` | send that JSON object as the body |

---

## How many logins do I need?

Google enforces concurrency limits on how many meetings one account can join simultaneously. MeetStream spreads signed-in bots across a domain's logins round-robin, so the documented rule of thumb is:

```
logins = peak concurrent Google Meet sessions / 20
```

Round up. A peak of 100 concurrent Google Meet bot sessions means **at least 5 logins**; 250 means 13.

`node index.js capacity --peak N` runs that formula and then checks it against reality - how many logins exist, how many are active, and how many sessions are in flight right now:

```
  Peak concurrent sessions   100
  Sessions per login         20
  ---------------------------------------------
  Minimum logins             5
  Recommended logins         5  (capacity 100 sessions)

  Configured logins          3
  Active logins              3  (capacity 60 sessions)
  Sessions in use right now  11

  SHORT by 2 login(s).
```

`--headroom 0.25` adds a 25% buffer on top of the rule of thumb, which is worth doing if your traffic is spiky. `--per-login` overrides the divisor if MeetStream tells you a different number for your account - the per-domain `max_concurrent_per_login` value shown by `domains list` is the authoritative figure for your workspace.

---

## What is and is not documented

This CLI does not invent request schemas. Here is exactly what it knows:

| Call | Request body |
| --- | --- |
| `POST /google-login-domains` | **Documented**: `user_id` (required), `name` (required), `login_mode` (optional, `always` or `if_required`) |
| `GET /google-login-domains` | none |
| `GET /google-login-domains/{domain}` | none |
| `PATCH /google-login-domains/{domain}` | **Not published.** The CLI sends whatever you pass via `--set` / `--payload`. The 200 response echoes `name` and `login_mode`, which are what the dashboard lets you change. |
| `DELETE /google-login-domains/{domain}` | none |
| `POST /google-logins` | **Not published.** Creating a login also involves uploading the SAML `cert.pem` / `key.pem` pair, which the dashboard handles per mail ID. Supply the body yourself with `--payload`, or `--field`/`--file` for multipart. |
| `GET /google-logins` | none |
| `PATCH /google-logins/{login_id}` | **Not published.** Same `--set` / `--payload` approach. The 200 response echoes `email` and `is_active`. |
| `DELETE /google-logins/{login_id}` | none |

Responses **are** documented and this CLI relies on them:

```jsonc
// GET /google-login-domains
{ "domains": [ { "sso_workspace_domain": "...", "name": "...", "login_mode": "always",
                 "max_concurrent_per_login": "30", "login_count": 0,
                 "active_login_count": 0, "created_at": "..." } ] }

// GET /google-logins
{ "logins": [ { "login_id": "...", "email": "...", "is_active": true,
                "active_sessions": 0, "last_test_status": "not_tested",
                "last_tested_at": null, "created_at": "..." } ] }
```

For anything marked "not published", check [the API reference](https://docs.meetstream.ai/api-reference/api-endpoints/google-signed-in-bots/create-google-login) before scripting against it, or use the dashboard (**Integrations → Google Signed-In Bots**), which is the supported path for certificate upload.

---

## How it works

```
index.js          command router, output formatting, delete confirmations
src/cli.js        argv parsing, --set key=value coercion
src/client.js     fetch wrapper - Token auth, 202 pending, 507 replay, backoff on 429/5xx
src/domains.js    /google-login-domains
src/logins.js     /google-logins, including the multipart path
src/capacity.js   the logins-per-peak-sessions math
```

Deletes prompt for confirmation unless you pass `--yes`, and refuse to run unattended without it.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing required environment variable MEETSTREAM_API_KEY` | `.env` missing or empty | `cp .env.example .env` and add your key |
| 401 / 403 | 401 = no key sent, 403 = key not valid for this workspace | Header must be `Authorization: Token <key>`; check for stray quotes |
| 404 on a domain you can see in the dashboard | The key belongs to a different workspace | Workspaces have separate keys; use the right one |
| 400 on `domains add` | Missing `--user-id` or `--name`, or a bad `--login-mode` | `login_mode` is `always` or `if_required` |
| `logins add` says nothing to send | The request body for `POST /google-logins` is not published, so the CLI will not guess | Use the dashboard, or pass `--payload` / `--field` / `--file` once you know the schema |
| A login has `last_test_status` other than success | The Workspace SSO profile or that login's certificate is wrong | Re-check the SSO profile URLs and re-upload `cert.pem` / `key.pem` for that mail ID |
| `active_sessions` pinned at the maximum | That login is saturated | Run `node index.js capacity --peak <your peak>` and add logins |
| 507 on `domains add` / `logins add` | Idempotent replay of a request you already sent | Treated as success; the CLI reports it as a replay |

## Related

- [Google signed-in bots guide](https://docs.meetstream.ai/guides/app-integrations/google-signed-in-bots)
- [List Google domains](https://docs.meetstream.ai/api-reference/api-endpoints/google-signed-in-bots/list-google-domains)
- [Create Google login](https://docs.meetstream.ai/api-reference/api-endpoints/google-signed-in-bots/create-google-login)
- [List Google logins](https://docs.meetstream.ai/api-reference/api-endpoints/google-signed-in-bots/list-google-logins)
- [Google Meet platform guide](https://docs.meetstream.ai/guides/platforms/google-meet)
- [Error codes](https://docs.meetstream.ai/errors)
- Related templates: [../google-signed-in-bots-setup](../google-signed-in-bots-setup), [../teams-signed-in-bots-setup](../teams-signed-in-bots-setup)
