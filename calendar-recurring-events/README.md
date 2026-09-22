# Schedule Meeting Bots for Recurring Calendar Events with MeetStream

Use the MeetStream API calendar endpoints to send meeting bots to recurring Zoom, Google Meet and Microsoft Teams meetings from a connected Google or Outlook calendar: schedule a whole series, chain one occurrence after another, book a single occurrence, and control auto-rescheduling with `POST /calendar/toggle-recurrence`.

```bash
npm install
cp .env.example .env      # fill in MEETSTREAM_API_KEY
node index.js list
```

## Prerequisites

- Node.js 18 or newer (uses the built-in `fetch`).
- A MeetStream API key from <https://app.meetstream.ai>, set as `MEETSTREAM_API_KEY`.
- A Google or Outlook calendar connected to your MeetStream account through the calendar OAuth flow, with at least one recurring meeting in the sync window. Connect one with [../google-calendar-integration](../google-calendar-integration) or [../outlook-calendar-integration](../outlook-calendar-integration) first; `list` prints `No events in the sync window. Connect a calendar first.` until you do.
- Only if you set `CALLBACK_URL`: a public HTTPS URL that MeetStream can reach for bot lifecycle webhooks (see [../webhook-local-tunnel](../webhook-local-tunnel)). Without it the bots still record; you just get no webhooks.
- No other third-party keys. The Zoom, Google Meet or Teams link comes from the calendar event itself.

## What it does

| Command | Call | Effect |
|---|---|---|
| `list` | `GET /calendar/events` | Lists events and flags which look recurring |
| `on <eventId>` | `POST /calendar/toggle-recurrence` `recurring_enabled: true` | Turn auto-rescheduling on for that event |
| `off <eventId>` | `POST /calendar/toggle-recurrence` `recurring_enabled: false` | Turn it off |
| `schedule-chain <eventId>` | `POST /calendar/schedule/{id}` `recurring_event: true` | One bot now, next occurrence booked after each meeting |
| `schedule-series <eventId> [n]` | `POST /calendar/schedule/{id}` `schedule_all_occurrences: true` | Book every future occurrence in one call |
| `schedule-one <eventId> <iso>` | `POST /calendar/schedule/{id}` `occurrence_date` | Book exactly one occurrence |
| `cancel-series <eventId>` | `DELETE /calendar/schedule/{id}` `cancel_all_occurrences: true` | Cancel the whole series |
| `cancel-from <eventId> <iso>` | same, plus `from_date` | Cancel from a date onward, keep earlier ones |

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/calendar-recurring-events
npm install
cp .env.example .env      # then fill in MEETSTREAM_API_KEY
node index.js list        # find event ids
node index.js schedule-chain <eventId>
```

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>` |
| `OCCURRENCE_LIMIT` | no | Cap for `schedule-series` (default `52`, the API default); a CLI argument overrides it |
| `BOT_NAME` | no | Bot display name in the meeting (default `MeetStream Recurring Bot`) |
| `VIDEO_REQUIRED` | no | Video is off by default; `true` records video as well as audio. Default `false`. |
| `VIDEO_LAYOUT` | no | Only read when `VIDEO_REQUIRED=true`. `speaker_view` (default) or `grid_view`. The API default is `grid_view`, so speaker view is sent explicitly. |
| `CALLBACK_URL` | no | Per-bot webhook URL for lifecycle events, public HTTPS |
| `MEETSTREAM_API_BASE_URL` | no | API base URL (default `https://api.meetstream.ai/api/v1`) |

## What you should see

`node index.js list` prints one block per event in the sync window, sorted by start time, then a recurrence tally. Ids and titles come from your calendar:

```text
3 event(s):

  <event_id>
    Weekly standup  [series: FREQ=WEEKLY;BYDAY=MO,WE,FR]
    starts 2026-04-14T10:00:00Z  link: yes
  <event_id>
    Weekly standup  [occurrence of a series]
    starts 2026-04-16T10:00:00Z  link: yes  bots: 1
  <event_id>
    Vendor call  [single]
    starts 2026-04-17T15:00:00Z  link: no

2 of 3 look recurring.
That reading comes from the raw provider payload and is a hint only.
toggle-recurrence is the authority: it returns 400 for an event with no rule.
```

`node index.js schedule-chain <eventId>` on a recurring event:

```text
Scheduling <event_id> with recurring_event: true
(one bot now, and the next occurrence is booked automatically after each meeting)

Scheduled.
  Bot id              : <bot_id>
  Schedule id         : <schedule_id>
  Joins at            : 2026-04-14T09:58:00Z
  Recurring occurrence: true
```

`node index.js on <eventId>` on a one-off event is the documented 400, printed as an outcome rather than an error:

```text
Enabling auto-rescheduling for <event_id>...

This event is not recurring (HTTP 400).

toggle-recurrence only applies to events with a recurrence rule.
For a one-off meeting use the calendar-schedule-bot template instead.
```

`node index.js cancel-series <eventId>` ends with `Cancelled.` followed by `Schedules cancelled`, `Bots deleted` and `Recurring series` counts from the API response. Any other API failure prints `API error <status>: <message>` with a `Hint:` line and exits 1.

## Series versus occurrence

A recurring meeting is one **series master** carrying a recurrence rule (an iCalendar RRULE), plus the individual **occurrences** it generates. MeetStream gives you three ways to cover a series, and they suit different things:

### 1. Chain: `recurring_event: true`

```bash
node index.js schedule-chain evt_abc123
```

One bot is scheduled for the next occurrence. When that meeting ends, MeetStream reads the recurrence rule, works out the following occurrence, and schedules another bot with the same config. That repeats indefinitely.

Best default for a standing meeting. One schedule exists at a time, so a series that changes shape stays correct, and there is nothing to clean up if you stop wanting it.

### 2. Batch: `schedule_all_occurrences: true`

```bash
node index.js schedule-series evt_abc123 12    # 12 occurrences
node index.js schedule-series evt_abc123       # default 52
```

Every future occurrence gets its own bot and its own schedule, right now. `occurrence_limit` caps it, default 52.

Use this when you want the full run visible in `GET /calendar/scheduled_bots` up front, for example to reconcile against a billing forecast. The tradeoff is that you now have many schedules to cancel if plans change, which is what `cancel-series` is for.

### 3. Single occurrence: `occurrence_date`

```bash
node index.js schedule-one evt_abc123 2026-04-14T10:00:00Z
```

Books exactly one occurrence of the series and nothing else. Use it for "record next Tuesday's standup only".

## Auto-rescheduling and `toggle-recurrence`

```bash
node index.js on  evt_abc123
node index.js off evt_abc123
```

```json
POST /calendar/toggle-recurrence
{ "event_id": "evt_abc123", "recurring_enabled": true }
```

Note there is **no path parameter**. The event id goes in the body.

Response: `{ event_id, recurring_enabled, recurrence_rule, message, summary, start_time, end_time }`.

**This endpoint returns 400 when the event has no recurrence rule.** That is the documented behaviour, not a bug, and it is the reliable way to find out whether MeetStream considers an event recurring. This template treats 400 as an expected outcome and explains it rather than dumping an error.

Turning it on is the same chaining behaviour as `recurring_event: true`, applied to an event you already scheduled. Turning it off stops the chain: the currently scheduled bot still runs, no further occurrences are booked.

### How the chain works

1. A bot joins a recurring meeting.
2. The meeting ends and MeetStream notices the event was recurring.
3. It computes the next occurrence from the RRULE.
4. It schedules a new bot for that occurrence with the same configuration.

Supported patterns are standard iCalendar RRULEs:

| Pattern | RRULE |
|---|---|
| Daily | `FREQ=DAILY` |
| Weekly | `FREQ=WEEKLY;BYDAY=MO,WE,FR` |
| Bi-weekly | `FREQ=WEEKLY;INTERVAL=2;BYDAY=TU` |
| Monthly | `FREQ=MONTHLY;BYDAY=1MO` |
| Yearly | `FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15` |

## When the series changes upstream

Handled for you through the provider's push notifications, with no polling and no API calls on your side:

| Change in the calendar | What MeetStream does |
|---|---|
| One occurrence moved | Updates that bot's join time in place |
| The whole series edited | Deletes the existing schedules and rebuilds them with the new times |
| Series or occurrence cancelled | Deletes the schedule, marks the bot `Cancelled` |
| Moved into the past | Deletes the schedule, cancels the bot |

## Detecting recurrence in `list`

The `list` command reads the `raw` field, which is the untouched upstream payload, so the shape depends on the provider:

- Google Calendar: `raw.recurrence` is an array of RRULE strings on the series master; instances carry `raw.recurringEventId`.
- Microsoft Graph: `raw.recurrence` is an object on the series master; occurrences carry `raw.seriesMasterId`.

Treat that reading as a hint. `toggle-recurrence` is the authority.

## Cancelling

```bash
node index.js cancel-series evt_abc123
node index.js cancel-from   evt_abc123 2026-05-01T00:00:00Z
```

`cancel_all_occurrences: true` drops every scheduled occurrence. Adding `from_date` keeps the occurrences before that date and cancels everything from it onward, which is the "we are pausing this standup from May" case.

Response: `{ unscheduled, event_id, cancelled_schedules, schedules_cancelled, bots_deleted, cancel_all_occurrences, is_recurring_series }`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `MEETSTREAM_API_KEY is not set` | `.env` missing or empty | `cp .env.example .env` and fill it in |
| 401 / 403 | 401 = no key sent, 403 = key rejected | Check `MEETSTREAM_API_KEY` for stray quotes or whitespace |
| `toggle-recurrence` returns 400 | The event has no recurrence rule; it is a one-off | Use [../calendar-schedule-bot](../calendar-schedule-bot) |
| 404 | Wrong event id | Use the `id` from `GET /calendar/events`, not `platform_id` |
| 409 on any schedule command | A bot already covers that event | Cancel first, or edit it with [../manage-scheduled-bots](../manage-scheduled-bots) |
| `schedule-series` booked fewer than expected | `occurrence_limit` capped it (default 52), or the series has an end date | Raise the limit, or accept the series length |
| Chain stopped after one meeting | `recurring_event` was not set, or auto-rescheduling was turned off with `off` | Run `on <eventId>`, which also reports the current rule |
| Only the master shows in `list` | Providers do not always expand every occurrence into the sync window | Use `schedule-one` with an `occurrence_date` against the master |

## Related

- [Scheduling bots](https://docs.meetstream.ai/guides/features/scheduling-bots)
- [Toggle recurring event](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/toggle-recurring-event)
- [Schedule event](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/schedule-event)
- [Remove schedule event](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/remove-schedule-event)
- [Fetch sync events](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/fetch-sync-events)
- [List scheduled bots](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/list-scheduled-bots)
- Related templates: [../calendar-event-sync](../calendar-event-sync) finds event ids and shows what is recurring; [../calendar-schedule-bot](../calendar-schedule-bot) covers the single, non-recurring case; [../manage-scheduled-bots](../manage-scheduled-bots) lists and edits the bots a series produces; [../calendar-auto-schedule](../calendar-auto-schedule) covers everything on the calendar, recurring or not.
