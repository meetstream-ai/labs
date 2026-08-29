# outlook-calendar-integration

Connect an Outlook / Microsoft 365 calendar to MeetStream: register an Azure app, get a refresh token with the bundled local helper, call `POST /calendar/create_outlook_calendar`, then verify the connection.

```bash
npm install
cp .env.example .env      # fill in MEETSTREAM_API_KEY, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET
npm run oauth             # one-time: opens the consent flow, prints your refresh token
# paste MICROSOFT_REFRESH_TOKEN into .env, then:
node index.js
```

## What it does

1. `npm run oauth` runs a throwaway local server on `http://localhost:3000`, sends you through the Microsoft identity platform consent screen, exchanges the authorization code at the v2.0 token endpoint, and prints a **refresh token**.
2. `node index.js` posts those three credentials to `POST /calendar/create_outlook_calendar`. MeetStream validates them against Microsoft, resolves your primary email through Microsoft Graph (that email becomes the connection's `account_id`), pulls the calendars on the account, and registers Graph change notification subscriptions.
3. It verifies by reading `GET /calendar`.

## Prerequisites

- Node.js 18 or newer (uses the built-in `fetch`).
- A MeetStream API key from <https://app.meetstream.ai>.
- A Microsoft account. Personal Outlook.com accounts and Microsoft 365 work accounts both work.
- Permission to register an app in your Azure tenant, or an admin who can grant consent for you.

## Part 1: Azure app registration (one time)

### 1. Register the app

1. Open the [Azure Portal](https://portal.azure.com/).
2. Go to **Microsoft Entra ID** (formerly Azure Active Directory) **> App registrations**.
3. Click **New registration**.
4. Name it something recognisable, for example `MeetStream Calendar`.
5. Under **Supported account types**, pick **Accounts in any organizational directory and personal Microsoft accounts**. Narrow this later if you only ever connect one tenant.
6. Under **Redirect URI**, choose platform **Web** and enter exactly:

   ```
   http://localhost:3000/api/microsoft/oauth-callback
   ```

   Character for character. If you change `OAUTH_PORT`, register that URI instead.
7. Click **Register**.
8. On the **Overview** page copy the **Application (client) ID** into `.env` as `MICROSOFT_CLIENT_ID`. Copy the **Directory (tenant) ID** too if you want to pin the flow to one tenant.

### 2. Create a client secret

1. In the app registration, go to **Certificates & secrets**.
2. **Client secrets > New client secret**. Add a description and an expiry.
3. Click **Add**, then immediately copy the **Value** column into `.env` as `MICROSOFT_CLIENT_SECRET`.

   Copy the **Value**, not the **Secret ID**. Azure only shows the value once. If you lose it, delete the secret and make a new one.

### 3. Add Microsoft Graph permissions

1. Go to **API permissions > Add a permission > Microsoft Graph > Delegated permissions**.
2. Add all three:

   | Permission | Why MeetStream needs it |
   |---|---|
   | `Calendars.Read` | Read calendars and events |
   | `User.Read` | Resolve the account's primary email, which becomes the `account_id` |
   | `offline_access` | Issue a refresh token so access survives past an hour |

   These are **delegated** permissions, not application permissions. MeetStream acts as you, and only reads.
3. If your tenant requires it, click **Grant admin consent for \<tenant\>**, or ask an admin to. Without consent the sign-in fails with `AADSTS65001`.

### 4. Get the refresh token

```bash
npm run oauth
```

Open <http://localhost:3000>, sign in, and approve. The browser page and the terminal both print the refresh token. Paste it into `.env` as `MICROSOFT_REFRESH_TOKEN` and stop the helper with Ctrl+C.

> **No refresh token came back?** `offline_access` is missing from the requested scope or was not consented to. Add it under **API permissions**, then run the helper again.

## Part 2: Connect to MeetStream

```bash
node index.js
```

Example output:

```
Connecting Outlook Calendar to MeetStream...

Connected.
  Account id      : jane@acme.com
  Email           : jane@acme.com
  Name            : Jane Doe
  Provider        : outlook
  Platform        : outlook_calendar
  Connection id   : outlook_calendar_usr_abc123
  Subscriptions   : 12 registered

Verifying...

Connections on this MeetStream user: 1
  - [outlook] jane@acme.com  (12 calendars)

12 calendar(s) visible to MeetStream:
  - Calendar  (primary, role=owner)
  ...
```

## How it works

### `POST /calendar/create_outlook_calendar`

```json
{
  "microsoft_client_id": "...",
  "microsoft_client_secret": "...",
  "microsoft_refresh_token": "...",
  "replace": false
}
```

| Field | Required | Notes |
|---|---|---|
| `microsoft_client_id` | yes | Application (client) ID |
| `microsoft_client_secret` | yes | Secret **value** |
| `microsoft_refresh_token` | yes | From the OAuth helper |
| `replace` | no, default `false` | Allows overwriting an existing connection for the same account, for token rotation |

Response fields this template reads: `calendar_id`, `platform`, `provider`, `account_id`, `user_email`, `user_name`, `primary_calendar_id`, `calendars[]`, `watch_setup`, `message`.

### Multiple accounts

One MeetStream user can hold many connections, keyed by `(provider, account_id)`. To attach a second Microsoft account, run the OAuth helper again while signed in as that account and call `node index.js` with the new refresh token. Existing connections, Outlook or Google, are untouched. There is no separate "add account" endpoint.

### The 409 on reconnect

Connecting an account that is already attached returns **409 Conflict** rather than silently replacing a live connection. This template treats 409 as an expected outcome and tells you what to do:

```bash
node index.js --replace     # sends "replace": true
```

### Verification endpoints

- `GET /calendar` returns the calendars behind your connection. There is no `/calendar/connections` path in the API.
- `GET /calendar` returns `{ total, user_id, calendars: [...] }`, a live read through to the provider.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `AADSTS50011` redirect URI mismatch | The URI in Azure does not match `http://localhost:<OAUTH_PORT>/api/microsoft/oauth-callback` exactly. Check the platform is **Web**, not **Single-page application**. |
| `AADSTS65001` consent required | An admin has to grant consent for the delegated permissions in your tenant. |
| `AADSTS7000215` invalid client secret | You pasted the Secret **ID** instead of the Secret **Value**, or the secret expired. |
| `AADSTS700016` application not found | Wrong `MICROSOFT_CLIENT_ID`, or the app lives in a tenant that `MICROSOFT_TENANT_ID=common` cannot reach. |
| Helper prints "No refresh token" | `offline_access` is not in the granted permissions. |
| API error 401 | `MEETSTREAM_API_KEY` is not set. |
| API error 403 | The API key was rejected. Copy the whole key. |
| API error 409 on connect | The account is already connected. Use `node index.js --replace`. |
| API error 400 "Maximum of 200 ... connections" | Per-user connection limit reached across Google plus Outlook. Disconnect one first. |
| A personal Outlook.com account is refused | `MICROSOFT_TENANT_ID` is set to `organizations` or a specific tenant. Use `common`. |

## Related templates

- `calendar-event-sync` reads the events this connection exposes.
- `calendar-schedule-bot` puts a bot on one specific event.
- `calendar-auto-schedule` turns on hands-free auto-join.
- `calendar-disconnect` tears a connection down again.
- `google-calendar-integration` is the same flow for Google Calendar.
