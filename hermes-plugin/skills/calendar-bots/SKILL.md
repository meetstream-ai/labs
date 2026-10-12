---
name: calendar-bots
description: >
  Put MeetStream bots on upcoming calendar meetings. Use when the user says
  "what meetings do I have", "send a bot to my 3pm", "record my next meeting",
  "join everything on my calendar today", "cancel the bot for that event", or
  asks about meetings on a connected Google Calendar.
---

# Calendar bots

Two MCP tools (named `mcp__meetstream__<tool>` in Hermes):

| Tool | Does |
|---|---|
| `list_calendar_events` | Upcoming events from the Google Calendars connected to the user's MeetStream account. |
| `schedule_calendar_bot` (`event_id`, `action`) | `action: "schedule"` puts a bot on that event; `"unschedule"` removes it. |

## Flow

1. `list_calendar_events`, then show the user the matching events (title, time,
   whether a meeting link exists).
2. Confirm which ones before scheduling - a bot appearing in a meeting is visible
   to everyone in it.
3. `schedule_calendar_bot` per confirmed event.

## When the calendar is empty or missing

Connecting a calendar (Google OAuth or Outlook) is **REST/dashboard only** - there
is no MCP tool for it. If `list_calendar_events` returns nothing or an error,
tell the user to connect a calendar in the MeetStream dashboard.

For a one-off future meeting that is not on a connected calendar, use
`create_bot` with `join_at` instead (see `join-meeting`).

## Reference

- [Fetch synced events](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/fetch-sync-events)
- [Google Calendar setup](https://docs.meetstream.ai/guides/calendar-integrations/google-calendar-oauth-setup)
- [Scheduling bots](https://docs.meetstream.ai/guides/features/scheduling-bots)
