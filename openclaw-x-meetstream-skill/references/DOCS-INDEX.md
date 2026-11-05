# Live documentation coverage index

Retrieved 2026-09-11: 119 guide/API pages and the OpenAPI document fetched successfully.
This is a discovery index, not a claim that every upstream example has been live-tested.
Start with PRODUCT-AND-SETUP.md, OPERATIONS.md, MIA.md, CALENDARS.md,
STREAMING.md and WEBHOOKS.md; use the page links below for exhaustive details.

## Instructions for AI Agents

- For clean Markdown of any page, append `.md` to the page URL
- For section-specific indexes, append `/llms.txt` to any section URL
- For AI client integration (Claude Code, Cursor, etc.), connect to the MCP server at https://docs.meetstream.ai/_mcp/server

## Docs

- [Welcome to MeetStream!](https://docs.meetstream.ai/welcome.md): MeetStream is a meeting bot API: send bots into Zoom, Google Meet, and Microsoft Teams to record, transcribe, and interact in real time through a single integration.
- [How MeetStream Bots Work](https://docs.meetstream.ai/guides/introduction/how-bots-work.md): How MeetStream meeting bots work: what a bot is, the join-record-process lifecycle, where artifacts come from, and how the pieces of the API fit together.
- [Meeting Platforms Supported](https://docs.meetstream.ai/navigation.md): Meeting platforms MeetStream bots support: Zoom, Google Meet, and Microsoft Teams, with feature availability per platform.
- [Getting Started](https://docs.meetstream.ai/guides/get-started/dashboard-setup.md): Step-by-step guides to help you integrate and use MeetStream effectively
- [Create Your First Meeting Bot](https://docs.meetstream.ai/guides/get-started/create-your-first-bot.md): Send one API request to put a recording bot in a Zoom, Google Meet, or Microsoft Teams meeting, then check its status, download the recording, and remove it.
- [API Playground](https://docs.meetstream.ai/guides/get-started/api-playground.md): The MeetStream API Playground is a visual bot builder in the dashboard: configure a bot across 10 steps, preview it live, and copy the exact API request it generates.
- [Workspaces](https://docs.meetstream.ai/guides/get-started/workspaces.md): Use MeetStream workspaces as environments: workspace-scoped API keys, per-workspace bots and usage, and team access from the dashboard.
- [Zoom Meeting Bots](https://docs.meetstream.ai/guides/platforms/zoom.md): Run meeting bots on Zoom with the MeetStream API: one-time Marketplace app setup, customer-hosted ZAK and OBF token URLs, recording permission flow, per-participant audio and video, and Zoom-specific timeouts.
- [Google Meet Bots](https://docs.meetstream.ai/guides/platforms/google-meet.md): Run meeting bots on Google Meet with the MeetStream API: zero setup, lobby and admission behavior, signed-in bots that skip the waiting room, per-participant audio and video, and calendar auto-join.
- [Microsoft Teams Bots](https://docs.meetstream.ai/guides/platforms/microsoft-teams.md): Run meeting bots on Microsoft Teams with the MeetStream API: zero setup, Outlook Calendar auto-join, per-participant audio and video, native captions, and Teams-specific timeout defaults.
- [Deduplication & Idempotency Keys](https://docs.meetstream.ai/guides/features/deduplication-idempotency-keys.md): Prevent duplicate meeting bots with deduplication keys and safely retry create_bot calls with idempotency keys.
- [Automatic Leave Configurations](https://docs.meetstream.ai/guides/features/automatic-leave-configuration.md): Configure when a meeting bot leaves automatically: waiting room, everyone-left, voice inactivity, and recording timeouts, with defaults for each.
- [Mid Meeting Recording Controls](https://docs.meetstream.ai/guides/features/pause-resume-recording.md): Pause and resume a meeting bot's recording mid-call via API, and what happens to the output files.
- [Amazon S3](https://docs.meetstream.ai/guides/features/custom-storage-configurations/amazon-s3.md)
- [Alibaba Cloud OSS](https://docs.meetstream.ai/guides/features/custom-storage-configurations/alibaba-cloud-oss.md)
- [Scheduling Bots](https://docs.meetstream.ai/guides/features/scheduling-bots.md): Schedule MeetStream bots ahead of time: join_at for one-off future joins, calendar event scheduling with recurring support, full auto-join, rescheduling, and deduplication.
- [In-Meeting Chat & Visuals](https://docs.meetstream.ai/guides/features/chat-and-visuals.md): Interact inside live meetings with the MeetStream API: send chat messages, display images and GIFs as the bot's video frame, set a join message, and read the full chat log.
- [Participants & Speaker Timeline](https://docs.meetstream.ai/guides/features/participants-and-speaker-timeline.md): Identify meeting participants uniquely and reconstruct who spoke when with the MeetStream API: get_participants fields, stable per-platform IDs, and the byte-level speaker timeline.
- [Custom Attributes](https://docs.meetstream.ai/guides/features/custom-attributes.md): Attach custom key-value metadata to MeetStream bots: echoed in every webhook, filterable in List Bots, visible in the usage dashboard — the backbone of multi-tenant routing and attribution.
- [Usage & Retention](https://docs.meetstream.ai/guides/features/usage-and-retention.md): Understand MeetStream usage and retention: what accrues bot hours, the Usage dashboard with per-bot cost breakdown, retention windows, data deletion, and the timeouts that protect your spend.
- [Zoom Marketplace App Setup](https://docs.meetstream.ai/guides/app-integrations/zoom-marketplace-app-setup.md): Configure a Zoom General App with Meeting SDK, save app credentials in MeetStream, and host OAuth and ZAK or OBF token minting.
- [Zoom App Production Submission](https://docs.meetstream.ai/guides/app-integrations/zoom-app-production-submission.md): Prepare your Zoom Meeting SDK app and customer-hosted ZAK/OBF OAuth flow for production.
- [Zoom Authenticated Bots (ZAK and OBF)](https://docs.meetstream.ai/guides/app-integrations/zoom-authenticated-bots.md)
- [Google Signed-In Bots](https://docs.meetstream.ai/guides/app-integrations/google-signed-in-bots.md): Send Google signed-in bots to Google Meet so they join as authenticated participants instead of anonymous guests.
- [Google Meet Lobby & Admission Troubleshooting](https://docs.meetstream.ai/guides/app-integrations/gmeet-lobby-admission.md): Troubleshoot Google Meet lobby and admission issues: why bots wait, host admission behaviour, and timeout settings.
- [Google Calendar OAuth Setup](https://docs.meetstream.ai/guides/calendar-integrations/google-calendar-oauth-setup.md): Connect Google Calendar to MeetStream with the OAuth refresh-token flow so bots can auto-join scheduled meetings.
- [Outlook Calendar Setup](https://docs.meetstream.ai/guides/calendar-integrations/outlook-calendar-setup.md): Connect Outlook Calendar to MeetStream so bots can auto-join scheduled Microsoft Teams meetings.
- [Retrieve Recordings](https://docs.meetstream.ai/guides/transcription-recordings/retrieve-recordings.md): Fetch meeting bot recordings from the MeetStream API: mixed audio, video with metadata, per-participant streams, presigned URL lifetimes, and 202 still-processing handling.
- [Create Bot with Post Call Transcription](https://docs.meetstream.ai/guides/transcription-recordings/post-call-transcription.md): Get a speaker-labeled transcript after a meeting ends: provider options, create_bot config, and fetching results.
- [Create Bot with Live Transcription](https://docs.meetstream.ai/guides/transcription-recordings/live-transcription.md): Stream live, speaker-attributed meeting transcripts to your webhook in real time using streaming transcription providers.
- [Create Bot with Per Participant Video](https://docs.meetstream.ai/guides/transcription-recordings/per-participant-video.md): Capture separate video streams per participant on Zoom, Google Meet, and Microsoft Teams meetings.
- [Create Bot with Per Participant Audio](https://docs.meetstream.ai/guides/transcription-recordings/per-participant-audio.md): Capture a separate audio file per participant on Zoom, Google Meet, and Microsoft Teams, with per-platform isolation behaviour.
- [Transcription Providers](https://docs.meetstream.ai/guides/transcription-recordings/providers/transcription-providers.md): Compare every transcription provider on MeetStream: Deepgram, AssemblyAI, Sarvam, JigsawStack, the in-house MeetStream engine, native meeting captions, and the streaming providers for live transcripts.
- [Deepgram](https://docs.meetstream.ai/guides/transcription-recordings/providers/deepgram.md): Use Deepgram nova-3 to transcribe meeting bot recordings on Zoom, Google Meet, and Teams: full config reference with defaults, diarization, keywords, and example payloads.
- [AssemblyAI](https://docs.meetstream.ai/guides/transcription-recordings/providers/assemblyai.md): Use AssemblyAI universal-2 to transcribe meeting bot recordings: speaker labels, PII redaction, auto chapters, entity detection — full config reference with defaults.
- [Sarvam](https://docs.meetstream.ai/guides/transcription-recordings/providers/sarvam.md): Use Sarvam saaras:v3 to transcribe or translate meeting bot recordings, with diarization and Indic-language strength — full config reference with defaults.
- [MeetStream Engine](https://docs.meetstream.ai/guides/transcription-recordings/providers/meetstream.md): Use MeetStream's in-house transcription engine for meeting bot recordings: automatic language detection and optional translation, with no third-party processor involved.
- [JigsawStack](https://docs.meetstream.ai/guides/transcription-recordings/providers/jigsawstack.md): Use JigsawStack to transcribe meeting bot recordings in 162 supported languages: automatic detection, optional translation, and per-speaker output.
- [Meeting Captions](https://docs.meetstream.ai/guides/transcription-recordings/providers/meeting-captions.md): Capture Google Meet or Microsoft Teams native captions as the meeting transcript — zero configuration, no external transcription engine.
- [Deepgram Streaming](https://docs.meetstream.ai/guides/transcription-recordings/providers/deepgram-streaming.md): Stream live meeting transcripts with Deepgram nova-2: sentence, word, or raw modes, VAD events, endpointing — full config reference with defaults.
- [AssemblyAI Streaming](https://docs.meetstream.ai/guides/transcription-recordings/providers/assemblyai-streaming.md): Stream live meeting transcripts with AssemblyAI universal-streaming-english: raw or sentence modes, end-of-turn detection tuning — full config reference with defaults.
- [Diarization Explained](https://docs.meetstream.ai/guides/transcription-recordings/diarization.md): How MeetStream attributes meeting speech to speakers: platform-level stream isolation on Zoom, Meet, and Teams versus provider-level diarization in transcripts, and when to use which.
- [Languages & Translation](https://docs.meetstream.ai/guides/transcription-recordings/languages-and-translation.md): Multilingual meeting transcription on MeetStream: per-provider language options, automatic language detection, and Sarvam and MeetStream engine translation modes.
- [Webhooks and Events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events.md): Every MeetStream webhook event from bot.joining to bot.done, with payload examples and how to handle bot.stopped statuses.
- [Set Up Local Server for Webhook](https://docs.meetstream.ai/guides/webhooks/local-webhook-server.md): Receive MeetStream webhooks on localhost during development using ngrok or Cloudflare tunnels.
- [Workspace Webhook Endpoints](https://docs.meetstream.ai/guides/webhooks/workspace-webhooks.md): Create workspace-level webhook endpoints in the MeetStream dashboard: pick exactly which bot lifecycle and post-call events to receive, and inspect deliveries in the Logs tab.
- [Verifying Webhook Signatures](https://docs.meetstream.ai/guides/webhooks/webhook-signature-verification.md): Verify MeetStream webhook signatures: HMAC-SHA256 over the raw body, the X-MeetStream-Signature and X-MeetStream-Timestamp headers, and copy-paste verification code for Python and Node.
- [What is MIA?](https://docs.meetstream.ai/guides/mia/what-is-mia.md)
- [Create an Agent](https://docs.meetstream.ai/guides/mia/create-an-agent.md)
- [MIA API Guide](https://docs.meetstream.ai/guides/mia/mia-api-guide.md)
- [MIA Custom Configurations](https://docs.meetstream.ai/guides/mia/mia-custom-configurations.md)
- [Real-time Audio Streaming](https://docs.meetstream.ai/guides/websockets/real-time-audio-streaming.md): Receive real-time meeting audio over WebSocket: enable live_audio_required, decode base64 PCM frames, and handle reconnects.
- [Meeting Control and Command Patterns](https://docs.meetstream.ai/guides/websockets/meeting-control-patterns.md): Control a live meeting bot over WebSocket: speak, mute, send chat, and other command patterns via socket_connection_url.
- [Bridge Server Architecture](https://docs.meetstream.ai/guides/websockets/bridge-server-architecture.md): Build a bridge server that connects MeetStream's live audio and control WebSockets to your voice AI pipeline for two-way meeting audio.
- [Debugging Bots](https://docs.meetstream.ai/guides/help/debugging-bots.md): Debug MeetStream meeting bots: the full status lifecycle, what NotAllowed / Denied / Failed mean, 202 still-processing responses, dashboard filters, and live webhook debugging with the CLI.
- [FAQ](https://docs.meetstream.ai/guides/help/faq.md): Answers to common MeetStream questions: supported platforms, authentication, recording retrieval, retention, per-participant streams, scheduling, webhooks, and AI tooling.
- [Get Support](https://docs.meetstream.ai/guides/help/support.md): How to get help with MeetStream: self-serve debugging, docs search from your editor via MCP, and reaching the team at support@meetstream.ai.
- [API Reference Introduction](https://docs.meetstream.ai/api-reference/introduction.md): Overview of the MeetStream API — base URL, authentication, and the full map of endpoint groups (bots, transcription, calendar, Google signed-in bots, MIA).
- [Authentication](https://docs.meetstream.ai/api-reference/authentication.md): How to authenticate with the MeetStream API — the Authorization Token header, where to get your API key, and a ready-to-run example.
- [Errors](https://docs.meetstream.ai/errors.md): Complete MeetStream API error reference — HTTP status codes (400, 401, 403, 404, 409, 429, 500, 503, 507, 202), their meanings, real response bodies, and how to handle each.
- [Create Bot Payload Reference](https://docs.meetstream.ai/api-reference/create-bot-payload-reference.md)
- [Claude Integration](https://docs.meetstream.ai/build-with-ai/claude-integration.md): Connect Claude to the MeetStream docs and API: documentation-search MCP, Claude Code plugin, and agent setup.
- [MeetStream MCP Server](https://docs.meetstream.ai/build-with-ai/meetstream-mcp-server.md): Connect Claude Desktop, Claude Code, Cursor, and any MCP client to the MeetStream meeting-bot API. Remote (hosted) and local options, full tool list, and step-by-step setup.
- [Agent Skills](https://docs.meetstream.ai/build-with-ai/agent-skills.md): MeetStream agent skills for Claude Code and other agent clients. Install the plugin marketplace or fetch any SKILL.md directly.
- [MeetStream CLI](https://docs.meetstream.ai/build-with-ai/meetstream-cli.md): Install @meetstream/cli to create meeting bots, watch their status, fetch transcripts, and debug webhooks from your terminal — no code required.
- [Docs for Agents & LLMs](https://docs.meetstream.ai/build-with-ai/docs-for-agents.md): Use MeetStream docs from AI agents: llms.txt index, .md versions of every page, the docs-search and action MCP servers, agent-friendly CLI output, and the published OpenAPI spec.
- [Migrate from Recall.ai](https://docs.meetstream.ai/migration/migrate-from-recall.md): Move an existing Recall.ai integration to MeetStream.ai. The migration kit rewrites endpoints, fields, and webhook handlers automatically and flags anything that needs manual review.

## API Docs

- API Endpoints > Bot Endpoints [Create Bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot.md)
- API Endpoints > Bot Endpoints [Reschedule Bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/reschedule-bot.md)
- API Endpoints > Bot Endpoints [Delete Scheduled Bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/delete-scheduled-bot.md)
- API Endpoints > Bot Endpoints [Get Bot Status](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-status.md)
- API Endpoints > Bot Endpoints [Get Bot Details](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-details.md)
- API Endpoints > Bot Endpoints [Get Bot Summary](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-summary.md)
- API Endpoints > Bot Endpoints [Get Bot Audio](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-audio.md)
- API Endpoints > Bot Endpoints [Get Bot Video](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-video.md)
- API Endpoints > Bot Endpoints [Get Recording Streams](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-recording-streams.md)
- API Endpoints > Bot Endpoints [Get Audio Streams](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-audio-streams.md)
- API Endpoints > Bot Endpoints [Remove Bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/remove-bot.md)
- API Endpoints > Bot Endpoints [Pause Bot Recording](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/pause-bot-recording.md)
- API Endpoints > Bot Endpoints [Resume Bot Recording](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/resume-bot-recording.md)
- API Endpoints > Bot Endpoints [Get Speaker Timeline](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-speaker-timeline.md)
- API Endpoints > Bot Endpoints [Get Bot Chats](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-chats.md)
- API Endpoints > Bot Endpoints [Get Bot Screenshots](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-screenshots.md)
- API Endpoints > Bot Endpoints [Fetch Participants](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/fetch-participants.md)
- API Endpoints > Bot Endpoints [Delete Data](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/delete-bot-data.md)
- API Endpoints > Bot Endpoints [List Bots](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/list-bots.md)
- API Endpoints > Bot Endpoints [Send Message](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/send-message.md)
- API Endpoints > Bot Endpoints [Send Image](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/send-image.md)
- API Endpoints > Transcription [Get Transcription](https://docs.meetstream.ai/api-reference/api-endpoints/transcription/get-transcription.md)
- API Endpoints > Transcription [Transcribe](https://docs.meetstream.ai/api-reference/api-endpoints/transcription/transcribe-bot-audio.md)
- API Endpoints > Transcription [Transcriptions](https://docs.meetstream.ai/api-reference/api-endpoints/transcription/get-bot-transcriptions.md)
- API Endpoints > Calendar [Create Calendar](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/create-calendar.md)
- API Endpoints > Calendar [Disconnect Calendar](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/disconnect-calendar.md)
- API Endpoints > Calendar [Get Calendars](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/get-calendars.md)
- API Endpoints > Calendar [Schedule Event](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/schedule-event.md)
- API Endpoints > Calendar [Remove Schedule Event](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/remove-schedule-event.md)
- API Endpoints > Calendar [Fetch/Sync Events](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/fetch-sync-events.md)
- API Endpoints > Calendar [Toggle Recurring Event](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/toggle-recurring-event.md)
- API Endpoints > Calendar [Setup Cron](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/setup-cron.md)
- API Endpoints > Calendar [Disable Cron](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/disable-cron.md)
- API Endpoints > Calendar [Get Auto-Schedule Settings](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/get-auto-schedule-settings.md)
- API Endpoints > Calendar [List Scheduled Bots](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/list-scheduled-bots.md)
- API Endpoints > Calendar [Create Outlook Calendar](https://docs.meetstream.ai/api-reference/api-endpoints/calendar/create-outlook-calendar.md)
- API Endpoints > Storage Config [Set Storage Config](https://docs.meetstream.ai/api-reference/api-endpoints/storage-config/set-storage-config.md)
- API Endpoints > Storage Config [Get Storage Config](https://docs.meetstream.ai/api-reference/api-endpoints/storage-config/get-storage-config.md)
- API Endpoints > Storage Config [Delete Storage Config](https://docs.meetstream.ai/api-reference/api-endpoints/storage-config/delete-storage-config.md)
- API Endpoints > Google Signed in Bots [Create Google Domain](https://docs.meetstream.ai/api-reference/api-endpoints/google-signed-in-bots/create-google-domain.md)
- API Endpoints > Google Signed in Bots [List Google Domains](https://docs.meetstream.ai/api-reference/api-endpoints/google-signed-in-bots/list-google-domains.md)
- API Endpoints > Google Signed in Bots [Get Google Domain](https://docs.meetstream.ai/api-reference/api-endpoints/google-signed-in-bots/get-google-domain.md)
- API Endpoints > Google Signed in Bots [Update Google Domain](https://docs.meetstream.ai/api-reference/api-endpoints/google-signed-in-bots/update-google-domain.md)
- API Endpoints > Google Signed in Bots [Delete Google Domain](https://docs.meetstream.ai/api-reference/api-endpoints/google-signed-in-bots/delete-google-domain.md)
- API Endpoints > Google Signed in Bots [Create Google Login](https://docs.meetstream.ai/api-reference/api-endpoints/google-signed-in-bots/create-google-login.md)
- API Endpoints > Google Signed in Bots [List Google Logins](https://docs.meetstream.ai/api-reference/api-endpoints/google-signed-in-bots/list-google-logins.md)
- API Endpoints > Google Signed in Bots [Update Google Login](https://docs.meetstream.ai/api-reference/api-endpoints/google-signed-in-bots/update-google-login.md)
- API Endpoints > Google Signed in Bots [Delete Google Login](https://docs.meetstream.ai/api-reference/api-endpoints/google-signed-in-bots/delete-google-login.md)
- API Endpoints > MIA [Create Agent Config](https://docs.meetstream.ai/api-reference/api-endpoints/mia/create-agent-config.md)
- API Endpoints > MIA [Update Agent Config](https://docs.meetstream.ai/api-reference/api-endpoints/mia/update-agent-config.md)
- API Endpoints > MIA [Get Agent Configs](https://docs.meetstream.ai/api-reference/api-endpoints/mia/get-agent-configs.md)
- API Endpoints > MIA [Delete Agent Config](https://docs.meetstream.ai/api-reference/api-endpoints/mia/delete-agent-config.md)

## OpenAPI Specification

The raw OpenAPI 3.1 specification for this API is available at:
- [OpenAPI JSON](https://docs.meetstream.ai/openapi.json)
- [OpenAPI YAML](https://docs.meetstream.ai/openapi.yaml)
