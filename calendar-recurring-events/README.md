# calendar-recurring-events

Recurring meetings: schedule a whole series or a single occurrence, and control auto-rescheduling with `POST /calendar/toggle-recurrence`.

```bash
npm install
cp .env.example .env      # fill in MEETSTREAM_API_KEY
node index.js list
```

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

## Prerequisites

- Node.js 18 or newer.
- A MeetStream API key from <https://app.meetstream.ai>.
- A connected calendar with at least one recurring meeting.

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

| Symptom | Cause and fix |
|---|---|
| `toggle-recurrence` returns 400 | The event has no recurrence rule. It is a one-off. Use `calendar-schedule-bot`. |
| 409 on any schedule command | A bot already covers that event. Cancel first, or edit it with `manage-scheduled-bots`. |
| `schedule-series` booked fewer than expected | `occurrence_limit` capped it, default 52. Also, a series with an end date only has so many occurrences. |
| Chain stopped after one meeting | `recurring_event` was not set, or auto-rescheduling was turned off with `off`. Check with `on`, which reports the current rule. |
| Only the master shows in `list` | Providers do not always expand every occurrence into the sync window. Use `occurrence_date` against the master to target a specific one. |
| API error 404 | Wrong event id. Use the `id` from `GET /calendar/events`, not `platform_id`. |
| API error 401 / 403 | `MEETSTREAM_API_KEY` missing or rejected. |

## Related templates

- `calendar-event-sync` finds event ids and shows what is recurring.
- `calendar-schedule-bot` covers the single, non-recurring case.
- `manage-scheduled-bots` lists and edits the bots a series produces.
- `calendar-auto-schedule` covers everything on the calendar, recurring or not.
