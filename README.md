# MeetStream Labs

Open source, runnable templates for the [MeetStream API](https://meetstream.ai) - the meeting bot API for Zoom, Google Meet and Microsoft Teams.

**63 templates covering every endpoint in the API.** Each folder is standalone: clone it, add your API key, run it.

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/quickstart-first-bot
npm install
cp .env.example .env      # add your MEETSTREAM_API_KEY
node index.js
```

Get an API key at [app.meetstream.ai](https://app.meetstream.ai/api-key). Node 18+ required.

---

## Start here

| Template | What it does |
|---|---|
| **[quickstart-first-bot](./quickstart-first-bot)** | The hello world: send a bot into a meeting, poll status, print the result |
| **[post-call-transcription](./post-call-transcription)** | Bot joins, records, and saves the full transcript when the call ends |
| **[transcript-fetcher](./transcript-fetcher)** | The canonical transcript flow: resolve `transcript_id`, poll through HTTP 202, parse segments |
| **[webhook-handler-complete](./webhook-handler-complete)** | The reference webhook receiver: every event, deduped redeliveries, correct `status_code` reading |

---

## Bots and lifecycle

| Template | What it does |
|---|---|
| [quickstart-first-bot](./quickstart-first-bot) | Create a bot, poll `GET /bots/{id}/status` until the session ends |
| [bot-status-monitor](./bot-status-monitor) | Render the bot lifecycle as a live timeline in your terminal |
| [list-and-manage-bots](./list-and-manage-bots) | List every bot, filter and sort, make an active bot leave |
| [bot-lifecycle-state-machine](./bot-lifecycle-state-machine) | Webhook-driven state machine, persisted to disk, detects stuck and abandoned bots |
| [scheduled-bot-join-at](./scheduled-bot-join-at) | Schedule with `join_at`, then reschedule and cancel |
| [manage-scheduled-bots](./manage-scheduled-bots) | Admin CLI for bots that have not joined yet |
| [bot-retention-config](./bot-retention-config) | Control how long recordings live with `recording_config.retention` |
| [delete-bot-data](./delete-bot-data) | Permanently erase a bot's data, behind a typed confirmation |
| [idempotency-and-dedup](./idempotency-and-dedup) | Both anti-duplicate mechanisms: `Idempotency-Key` (507 replay) and `deduplication_key` (409) |
| [bulk-bot-operations](./bulk-bot-operations) | Run many bots concurrently with a bounded queue and per-job idempotency |

## Recording and media

| Template | What it does |
|---|---|
| [audio-recording-downloader](./audio-recording-downloader) | Wait for `audio.processed`, then download the audio |
| [video-recording-downloader](./video-recording-downloader) | Same for video, via `video.processed` |
| [per-participant-audio-recorder](./per-participant-audio-recorder) | One audio file per participant, with correct HTTP 202 handling |
| [per-participant-video-recorder](./per-participant-video-recorder) | One video and audio stream per participant |
| [screenshot-capture](./screenshot-capture) | Download meeting screenshots and place them on the timeline |
| [pause-resume-recording](./pause-resume-recording) | Open and close recording privacy windows mid-meeting |
| [custom-s3-storage](./custom-s3-storage) | Bring your own bucket: point MeetStream at your own S3 via `PUT /admin/configs` |

## Transcription

| Template | What it does |
|---|---|
| [post-call-transcription](./post-call-transcription) | Full transcript saved after the call |
| [realtime-transcription](./realtime-transcription) | Streaming transcription over webhook or WebSocket while the meeting runs |
| [transcript-fetcher](./transcript-fetcher) | Resolve `transcript_id` and fetch, handling 202 correctly |
| [re-transcribe-audio](./re-transcribe-audio) | Re-run transcription with a different provider, model or language |
| [multi-provider-transcription](./multi-provider-transcription) | All five post-call providers, switched by one env var |
| [multilingual-transcription](./multilingual-transcription) | Non-English meetings with the right provider and language code |
| [speaker-diarization](./speaker-diarization) | Deepgram diarization into clean per-speaker turns |
| [live-captions-overlay](./live-captions-overlay) | Rolling live captions in your terminal |

## Meeting data and analytics

| Template | What it does |
|---|---|
| [ai-meeting-summary](./ai-meeting-summary) | MeetStream's native AI summary (`GET /bots/{id}/summary`) |
| [speaker-timeline-analytics](./speaker-timeline-analytics) | Talk-time, turns, longest monologue, ASCII bar chart |
| [participant-tracker](./participant-tracker) | Who joined and left, live over webhooks |
| [meeting-chat-logger](./meeting-chat-logger) | Export in-meeting chat to JSON and Markdown |
| [meeting-analytics-dashboard](./meeting-analytics-dashboard) | Everything about one meeting in a single consolidated report |

## Live interaction

| Template | What it does |
|---|---|
| [realtime-audio-streaming](./realtime-audio-streaming) | Live PCM audio over a WebSocket you host |
| [realtime-video-streaming](./realtime-video-streaming) | Live fMP4 video over WebSocket, with the ping/pong keepalive |
| [send-chat-message](./send-chat-message) | Post chat messages into a live meeting, on demand or scheduled |
| [send-image-bot](./send-image-bot) | Put an image or GIF into the chat, or make it the bot's camera feed |
| [websocket-bot-control](./websocket-bot-control) | The bring-your-own bridge: `sendaudio`, `sendmsg`, `sendchat`, `interrupt`, `sendimg` |
| [interactive-meeting-agent](./interactive-meeting-agent) | Two-way loop: hear the room, decide, respond |

## MIA (MeetStream Infrastructure Agents)

MIA agents run on MeetStream's own hosted bridge. Attach one by passing **only** `agent_config_id` on `create_bot`.

| Template | What it does |
|---|---|
| [MIA-chat-agent](./MIA-chat-agent) | Deploy a MIA into a meeting and watch it respond |
| [mia-voice-agent-pipeline](./mia-voice-agent-pipeline) | Pipeline mode: swap STT, LLM and TTS layers independently |
| [mia-realtime-agent](./mia-realtime-agent) | Realtime mode: a single speech-to-speech model, lower latency |
| [mia-agent-crud](./mia-agent-crud) | Admin CLI for saved agent configs |
| [mia-wake-word-assistant](./mia-wake-word-assistant) | Only answers when addressed: "hey acme, ..." |

## Calendar

| Template | What it does |
|---|---|
| [google-calendar-integration](./google-calendar-integration) | Connect Google Calendar, including a local OAuth helper |
| [outlook-calendar-integration](./outlook-calendar-integration) | Connect Outlook / Microsoft 365, including the Azure setup |
| [calendar-event-sync](./calendar-event-sync) | Sync upcoming events and find the ones with a join link |
| [calendar-schedule-bot](./calendar-schedule-bot) | Schedule a bot for one event, handling the 409 duplicate case |
| [calendar-auto-schedule](./calendar-auto-schedule) | A bot joins every meeting automatically |
| [calendar-recurring-events](./calendar-recurring-events) | Whole series or single occurrence, plus auto-rescheduling |
| [calendar-disconnect](./calendar-disconnect) | Tear down an integration, with a preview of what is lost |

## Platform specifics

| Template | What it does |
|---|---|
| [zoom-meeting-bot](./zoom-meeting-bot) | Zoom's recording-permission flow and its timeout ranges |
| [zoom-oauth-connections](./zoom-oauth-connections) | Let your end users connect their own Zoom account |
| [teams-meeting-bot](./teams-meeting-bot) | Microsoft Teams lifecycle and admission behaviour |
| [gmeet-lobby-handling](./gmeet-lobby-handling) | Google Meet waiting room: detect `NotAllowed` and `Denied`, then react |
| [google-signed-in-bots-setup](./google-signed-in-bots-setup) | SAML SSO, certificates and domain registration, end to end |
| [google-login-management](./google-login-management) | Admin CLI for signed-in bot domains and logins |

## Webhooks and reliability

| Template | What it does |
|---|---|
| [webhook-handler-complete](./webhook-handler-complete) | Every documented event, deduped, with correct status handling |
| [webhook-local-tunnel](./webhook-local-tunnel) | Get webhooks delivering to your laptop over a public HTTPS tunnel |
| [error-handling-and-retries](./error-handling-and-retries) | The whole error surface: 400, 401 vs 403, 409, 429 with `Retry-After`, 507, 202 |

## Integrations and AI workflows

| Template | What it does |
|---|---|
| [ai-meeting-notetaker-email](./ai-meeting-notetaker-email) | Record, summarize, and email the notes to attendees |
| [slack-meeting-summary](./slack-meeting-summary) | Post the summary and action items into Slack |
| [notion-meeting-notes](./notion-meeting-notes) | One Notion page per meeting |
| [crm-hubspot-sync](./crm-hubspot-sync) | Attach the summary and transcript to the HubSpot contact and deal |
| [action-item-extractor](./action-item-extractor) | LLM-extracted action items with owners and due dates |
| [sentiment-and-insights](./sentiment-and-insights) | Sentiment, topics and talk-time balance as a coaching report |

---

## Things every template gets right

These are the details that most commonly go wrong when integrating. Every template here handles them the same way:

- **Auth is `Authorization: Token <key>`** - the literal word `Token`, not `Bearer`.
- **The webhook envelope key is `event`**, not `bot_event`.
- **`bot.stopped` is the single terminal event.** `bot_status` says why: `Stopped`, `NotAllowed` (waiting room timeout), `Denied` (host refused), `Error`. Its `status_code` is `200` regardless of the reason.
- **Transcripts are fetched by `transcript_id`, not `bot_id`.** Segments carry `speaker` and **`transcript`** (not `text`).
- **HTTP 202 means "not ready, poll again"** - and streaming-only providers return 202 forever, so every poll loop is capped.
- **HTTP 507 is an idempotent replay** and should be treated as success, not an error.
- **Streaming-only providers end at `audio.processed`** and never emit `bot.done`.
- **MIA needs only `agent_config_id`.** `socket_connection_url` and `live_audio_required` are for bring-your-own-bridge templates and point at *your* server.

## Prerequisites

- Node.js 18 or newer (templates use built-in `fetch` and ESM)
- A MeetStream API key - [get one here](https://app.meetstream.ai/api-key)
- For webhook templates: a public HTTPS URL (see [webhook-local-tunnel](./webhook-local-tunnel))

## Contributing

Have a use case to share? Open a pull request. Templates follow a consistent layout: `README.md`, `.env.example`, `package.json`, `.gitignore`, `index.js`, and `src/*.js`.

## Resources

- [MeetStream Docs](https://docs.meetstream.ai)
- [API Reference](https://docs.meetstream.ai/api-reference)
- [Webhooks and Events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Migrating from Recall.ai](https://docs.meetstream.ai/migration/migrate-from-recall)
