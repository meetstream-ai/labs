# google-calendar-integration

Connect a Google Calendar to MeetStream: get an OAuth refresh token with the bundled local helper, call `POST /calendar/create_calendar`, then verify with `GET /calendar`.

```bash
npm install
cp .env.example .env      # fill in MEETSTREAM_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
npm run oauth             # one-time: opens the consent flow, prints your refresh token
# paste GOOGLE_REFRESH_TOKEN into .env, then:
node index.js
```

## What it does

1. `npm run oauth` runs a throwaway local server on `http://localhost:3000`, sends you through Google's consent screen, exchanges the authorization code, and prints a **refresh token**.
2. `node index.js` posts those three credentials to `POST /calendar/create_calendar`. MeetStream validates them against Google, pulls your calendar list, stores the credentials encrypted, and registers push notification channels so it hears about calendar edits in real time.
3. It then calls `GET /calendar` and prints every calendar MeetStream can see. That read goes live through to Google, so a clean result proves the credentials genuinely work.

## Prerequisites

- Node.js 18 or newer (uses the built-in `fetch`).
- A MeetStream API key from <https://app.meetstream.ai>.
- A Google account. A personal Gmail account is fine, Workspace is not required.

## Part 1: Google Cloud Console setup (one time)

This is the fiddly part. Do it once and the refresh token lasts indefinitely.

### 1. Create a project and enable the Calendar API

1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project, or select an existing one, using the project picker in the top bar.
3. Go to **APIs & Services > Library**.
4. Search for **Google Calendar API** and click **Enable**. Nothing else will work until this is on.

### 2. Configure the OAuth consent screen

1. Go to **APIs & Services > OAuth consent screen**.
2. Choose **External** (or **Internal** if this is a Google Workspace project and only your own org will connect).
3. Fill in the app name and support email, then save.
4. On the **Scopes** step, add these four:

   | Scope | Why MeetStream needs it |
   |---|---|
   | `https://www.googleapis.com/auth/calendar.readonly` | Read your calendar list |
   | `https://www.googleapis.com/auth/calendar.events.readonly` | Read events and their meeting links |
   | `https://www.googleapis.com/auth/userinfo.email` | Label the connection with your address |
   | `https://www.googleapis.com/auth/userinfo.profile` | Display name on the connection |

   All read-only. MeetStream never writes to your calendar.
5. On the **Test users** step, add your own Google address. While the app is in *Testing* status only listed test users can consent.

### 3. Create the OAuth client

1. Go to **APIs & Services > Credentials**.
2. Click **Create Credentials > OAuth client ID**.
3. Application type: **Web application**.
4. Under **Authorized redirect URIs**, add exactly:

   ```
   http://localhost:3000/api/google/oauth-callback
   ```

   This must match character for character. If you set `OAUTH_PORT` to something other than 3000, add that URI instead.
5. Click **Create** and copy the **Client ID** and **Client secret** into `.env`.

### 4. Get the refresh token

```bash
npm run oauth
```

Open <http://localhost:3000>, sign in, and approve the scopes. The browser page and the terminal both print the refresh token. Paste it into `.env` as `GOOGLE_REFRESH_TOKEN` and stop the helper with Ctrl+C.

> **No refresh token came back?** Google only issues one on the first consent, or after you revoke access. Revoke the app at <https://myaccount.google.com/permissions> and run `npm run oauth` again. The helper already sends `access_type=offline` and `prompt=consent`, which is everything you can do from the client side.

## Part 2: Connect to MeetStream

```bash
node index.js
```

Example output:

```
Connecting Google Calendar to MeetStream...

Connected.
  Account         : jane@example.com
  Name            : Jane Smith
  Connection id   : google_calendar_usr_abc123
  Platform        : google_calendar
  Primary calendar: jane@example.com
  Push channels   : 2 set up

Verifying with GET /calendar ...

2 calendar(s) visible to MeetStream:
  - jane@example.com  (primary, role=owner, America/Los_Angeles)
  - Team Meetings  (role=writer, America/Los_Angeles)
```

## How it works

### `POST /calendar/create_calendar`

```json
{
  "google_client_id": "...",
  "google_client_secret": "...",
  "google_refresh_token": "..."
}
```

The `google_` prefix on all three fields is mandatory. Sending `client_id` / `client_secret` / `refresh_token` returns a 400.

Response fields this template reads: `calendar_id`, `platform`, `user_email`, `user_name`, `primary_calendar_id`, `calendars[]`, `watch_setup`, `message`.

`watch_setup` reports how many Google push notification channels were registered. Those channels are what let MeetStream move a scheduled bot when you drag a meeting to a new time, and cancel it when you delete the meeting. MeetStream renews them automatically before their roughly 30 day expiry, so there is nothing to maintain.

### `GET /calendar`

Returns `{ total, user_id, calendars: [{ id, summary, description, isPrimary, accessRole, timeZone, backgroundColor, foregroundColor, selected, hidden }] }`.

### Re-running

Calling `create_calendar` again with updated credentials replaces the existing connection. You do not have to disconnect first, which makes secret rotation a single call.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `redirect_uri_mismatch` in the browser | The URI in Google Cloud Console does not match `http://localhost:<OAUTH_PORT>/api/google/oauth-callback` exactly. Check for a trailing slash or `127.0.0.1` instead of `localhost`. |
| `access_denied` on the consent screen | Your Google account is not in the **Test users** list while the consent screen is in Testing status. |
| Helper prints "No refresh token" | You have already consented before. Revoke at <https://myaccount.google.com/permissions> and retry. |
| API error 401 | `MEETSTREAM_API_KEY` is not set. |
| API error 403 | The API key was rejected. Copy the whole key, no surrounding whitespace. |
| API error 400 on `create_calendar` | Almost always a credential field name (must be `google_`-prefixed), or a refresh token that Google has already revoked. Re-run `npm run oauth`. |
| `calendars` list is empty | The Google Calendar API is not enabled on the project, or the token was minted without the `calendar.readonly` scope. |
| Port 3000 in use | Set `OAUTH_PORT` in `.env` and add the matching redirect URI in Google Cloud Console. |

## Related templates

- `calendar-event-sync` reads the events that this connection exposes.
- `calendar-schedule-bot` puts a bot on one specific event.
- `calendar-auto-schedule` turns on hands-free auto-join for every meeting.
- `calendar-disconnect` tears the connection down again.
- `outlook-calendar-integration` is the same flow for Microsoft 365.
