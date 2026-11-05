---
name: meetstream-calendar
description: List connected-calendar meetings and schedule or unschedule MeetStream bots for specific events.
homepage: https://docs.meetstream.ai
metadata: { "openclaw": { "emoji": "📅", "requires": { "bins": ["curl", "jq"] }, "primaryEnv": "MEETSTREAM_API_KEY" } }
---

# MeetStream Calendar Bots

Use `{baseDir}/../meetstream/scripts/calendar-bots.sh list` to show events from an
already connected Google Calendar. Schedule only the event the user explicitly
selects with `calendar-bots.sh schedule <event-id>`. Unscheduling is a real
change; confirm ambiguous event references and use
`calendar-bots.sh unschedule <event-id>`.

Connecting a new Google account requires OAuth client ID, secret, and refresh
token management and is intentionally outside the simple script. Follow the
official calendar instructions in the MeetStream Claude plugin for that
one-time administrative setup; never ask the user to paste those secrets into
chat or source files.
