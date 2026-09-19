# Published API reference and advanced execution

Snapshot: 2026-09-11, source https://docs.meetstream.ai/openapi.json.
The bundled [openapi.json](openapi.json) includes all published request/response
schemas, parameters, enums, defaults and required fields for 52 operations.
Read just the relevant path and referenced components; do not load it all into
the prompt. Endpoint paths below include /api/v1; omit that prefix in scripts.

## Advanced command

```bash
scripts/api-request.sh GET /mia
scripts/api-request.sh POST /bots/create_bot --body-file bot.json --idempotency-key '<uuid>'
scripts/api-request.sh POST '/bots/<bot-id>/pause_recording'
scripts/api-request.sh PATCH '/calendar/scheduled_bots/<bot-id>' --body-file schedule.json
```

The wrapper uses the same pinned origin and credential loader as other scripts;
JSON comes from a file or stdin (`--body-file -`), and output is raw JSON.
Use it for documented fields/endpoints without dedicated flags: MIA creation,
Zoom tokens, Google login, deduplication, auto-leave customization, storage,
calendar connection/recurrence, rescheduling, image output, re-transcription,
and data deletion. It checks JSON syntax, not the full operation schema.
Read the relevant guide and prepare the exact payload before invoking.
A user's authorization must cover the actual mutation; GET remove_bot also
mutates state. Never try every endpoint speculatively or retry writes blindly.

## Upstream discrepancies observed

- Retention: usage guide says 24 hours; schema says indefinite. Always set it.
- Video: recordings prose calls it opt-in; CreateBotRequest defaults true.
  Explicitly choose video_required; the convenience script defaults true.
- Lifecycle: current events guide uses bot_event and distinct terminal events;
  older examples use event. Normalize with bot_event first, event fallback.
- Guides contain fields missing from schema: deduplication_key, google_meet,
  agent_config_params, automatic_leave.bot_detection, expanded wake-word,
  speaker-aware and custom-function MIA settings.
- Guide-only routes include POST /bots/{id}/update_mia and calendar
  /connections, /connections/{provider}/{account_id}, /calendars, /get_events.
- MIA guide uses lowercase avatar; the schema exposes Avatar. Prefer the
  current guide for new payloads and confirm against the service if rejected.
- Storage schema permits only aws; the current OSS guide documents alibaba_oss.
- Some narrative examples abbreviate artifact/deletion/calendar paths. Use
  the specific endpoint reference, e.g. DELETE /bots/{id}/delete, or the newer
  explicit guide contract for endpoints absent from schema.

These conflicts are not proof of live backend behavior. Don't silently claim
resolution; use explicit settings and surface actual API errors. Re-fetch the
relevant .md page and OpenAPI when building a new integration or encountering
schema drift. Do not change the audit date without rechecking.

## Endpoint inventory

| Method | Path | Operation |
| --- | --- | --- |
| POST | `/api/v1/bots/create_bot` | Create Bot |
| PATCH | `/api/v1/calendar/scheduled_bots/{bot_id}` | Reschedule Bot |
| DELETE | `/api/v1/calendar/scheduled_bots/{bot_id}` | Delete Scheduled Bot |
| GET | `/api/v1/bots/{bot_id}/status` | Get Bot Status |
| GET | `/api/v1/bots/{bot_id}/detail` | Get Bot Details |
| GET | `/api/v1/bots/{bot_id}/summary` | Get Bot Summary |
| GET | `/api/v1/bots/{bot_id}/get_audio` | Get Bot Audio |
| GET | `/api/v1/bots/{bot_id}/get_video` | Get Bot Video |
| GET | `/api/v1/bots/{bot_id}/get_recording_streams` | Get Recording Streams |
| GET | `/api/v1/bots/{bot_id}/get_audio_streams` | Get Audio Streams |
| GET | `/api/v1/bots/{bot_id}/remove_bot` | Remove Bot |
| POST | `/api/v1/bots/{bot_id}/pause_recording` | Pause Bot Recording |
| POST | `/api/v1/bots/{bot_id}/resume_recording` | Resume Bot Recording |
| GET | `/api/v1/bots/{bot_id}/get_speaker_timeline` | Get Speaker Timeline |
| GET | `/api/v1/bots/{bot_id}/get_chats` | Get Bot Chats |
| GET | `/api/v1/bots/{bot_id}/get_screenshots` | Get Bot Screenshots |
| GET | `/api/v1/bots/{bot_id}/get_participants` | Fetch Participants |
| DELETE | `/api/v1/bots/{bot_id}/delete` | Delete Data |
| GET | `/api/v1/bots` | List Bots |
| POST | `/api/v1/bots/{bot_id}/send_message` | Send Message |
| POST | `/api/v1/bots/{bot_id}/send_image` | Send Image |
| GET | `/api/v1/transcript/{transcript_id}/get_transcript` | Get Transcription |
| POST | `/api/v1/bots/{bot_id}/transcribe` | Transcribe |
| GET | `/api/v1/bots/{bot_id}/transcriptions` | Transcriptions |
| POST | `/api/v1/calendar/create_calendar` | Create Calendar |
| POST | `/api/v1/calendar/disconnect` | Disconnect Calendar |
| GET | `/api/v1/calendar` | Get Calendars |
| POST | `/api/v1/calendar/schedule/{event_id}` | Schedule Event |
| DELETE | `/api/v1/calendar/schedule/{event_id}` | Remove Schedule Event |
| GET | `/api/v1/calendar/events` | Fetch/Sync Events |
| POST | `/api/v1/calendar/toggle-recurrence` | Toggle Recurring Event |
| POST | `/api/v1/calendar/auto-schedule/enable` | Setup Cron |
| POST | `/api/v1/calendar/auto-schedule/disable` | Disable Cron |
| GET | `/api/v1/calendar/auto-schedule/settings` | Get Auto-Schedule Settings |
| GET | `/api/v1/calendar/scheduled_bots` | List Scheduled Bots |
| POST | `/api/v1/calendar/create_outlook_calendar` | Create Outlook Calendar |
| PUT | `/api/v1/admin/configs` | Set Storage Config |
| GET | `/api/v1/admin/configs` | Get Storage Config |
| DELETE | `/api/v1/admin/configs` | Delete Storage Config |
| POST | `/api/v1/google-login-domains` | Create Google Domain |
| GET | `/api/v1/google-login-domains` | List Google Domains |
| GET | `/api/v1/google-login-domains/{domain}` | Get Google Domain |
| PATCH | `/api/v1/google-login-domains/{domain}` | Update Google Domain |
| DELETE | `/api/v1/google-login-domains/{domain}` | Delete Google Domain |
| POST | `/api/v1/google-logins` | Create Google Login |
| GET | `/api/v1/google-logins` | List Google Logins |
| PATCH | `/api/v1/google-logins/{login_id}` | Update Google Login |
| DELETE | `/api/v1/google-logins/{login_id}` | Delete Google Login |
| POST | `/api/v1/mia` | Create Agent Config |
| PUT | `/api/v1/mia` | Update Agent Config |
| GET | `/api/v1/mia` | Get Agent Configs |
| DELETE | `/api/v1/mia` | Delete Agent Config |
