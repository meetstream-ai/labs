# Calendar connection and scheduling

Verified 2026-09-11. These are MeetStream calendar integrations, distinct from
OpenClaw's own scheduler. Use `api-request.sh` for advanced operations and
`calendar-bots.sh` for listing and scheduling one existing event.

## Google OAuth

Enable Google Calendar API in Google Cloud, configure consent and a Web
application OAuth client, and register the exact callback (the guide's local
example is `http://localhost:3000/api/google/oauth-callback`). Request offline
consent for `calendar.events.readonly`, `calendar.readonly`, `userinfo.email`,
and `userinfo.profile` using their full Google OAuth scope URLs. Exchange
the authorization code server-side and retain the refresh token securely.
The official Node helper uses express, googleapis, and dotenv; adapt it to
validate OAuth state and avoid logging tokens.

POST `/calendar/create_calendar` with `google_client_id`,
`google_client_secret`, and `google_refresh_token`. Inspect watch setup
results; connection success alone is not proof every calendar watch succeeded.
The integration syncs changes and renews notification watches.
Source: [Google setup](https://docs.meetstream.ai/guides/calendar-integrations/google-calendar-oauth-setup).

## Outlook OAuth and multiple accounts

Register an Azure/Entra application; choose organizational and personal
accounts when both are needed. Register the callback, create a client secret,
and grant delegated `Calendars.Read`, `User.Read`, `offline_access` permissions
with required consent. Obtain a refresh token through authorization-code OAuth.
POST `/calendar/create_outlook_calendar` with `microsoft_client_id`,
`microsoft_client_secret`, `microsoft_refresh_token`; use `replace:true` to
rotate an existing connection (otherwise 409). Store secrets in a private
JSON file or pipe from a secret manager to `api-request.sh --body-file -`.

Connections are keyed by `(provider, account_id)`; `outlook` is the provider
name. GET `/calendar/connections` lists them. Scope event/calendar reads using
`?provider=outlook&account_id=<URL-encoded-email>`; account_id requires provider.
The guide lists up to 200 combined Google/Outlook connections per user.
DELETE `/calendar/connections/{provider}/{account_id}` disconnects exactly one;
it normally removes its events and schedules, while `?purge_events=false`
keeps history. Avoid broad disconnects without the user's explicit scope.
Source: [Outlook setup](https://docs.meetstream.ai/guides/calendar-integrations/outlook-calendar-setup).

## Run and maintain schedules

```bash
scripts/calendar-bots.sh list --json
scripts/calendar-bots.sh schedule '<MeetStream-event-id>'
scripts/calendar-bots.sh unschedule '<MeetStream-event-id>'
scripts/api-request.sh GET /calendar/scheduled_bots
```

Use the MeetStream event `id`, not the provider's event ID. GET
`/calendar/events` syncs and lists; follow `next` cursors to avoid missing
matches. Use the advanced wrapper for `calendar_id`, `time_min`, `time_max`,
`sync`, `limit`, `cursor`, or account filters. GET `/calendar/get_events` is
cached-only; `/calendar/calendars` lists underlying calendars.

One-off future joins use create_bot `join_at` with a timezone-qualified
ISO8601 value. PATCH `/calendar/scheduled_bots/{bot_id}` changes a pending bot;
DELETE on that path cancels it. An active bot instead uses remove_bot.
Calendar scheduling accepts `bot_config`; recurrence options include
`occurrence_date`, `schedule_all_occurrences`, `occurrence_limit`, and
`recurring_event`. Cancel-series options are `cancel_all_occurrences` and
`from_date`. POST `/calendar/toggle-recurrence` controls future rescheduling.
For full automation POST `/calendar/auto-schedule/enable` with
`default_bot_config`; inspect `/settings`, and POST `/disable` to stop it.
Check endpoint schemas and the scheduling guide before selecting the horizon
and recurrence behavior; enabling auto-join affects future meetings.
Source: [scheduling](https://docs.meetstream.ai/guides/features/scheduling-bots).

Duplicate event scheduling normally returns 409 with the existing bot; update
that schedule rather than dispatching another bot. For body-level deduplication
put `deduplication_key` inside calendar `bot_config`. See
[operations](OPERATIONS.md) for replay semantics.

Some newer calendar routes and request fields above appear in guides but are
absent from OpenAPI. See the discrepancy notes in [API-REFERENCE.md](API-REFERENCE.md).
