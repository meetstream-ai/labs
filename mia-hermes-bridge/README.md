# MeetStream MIA × Hermes Bridge

A Node.js/TypeScript reference integration that lets a self-hosted [Hermes Agent](https://github.com/NousResearch/hermes-agent) participate in Google Meet, Zoom, or Microsoft Teams through MeetStream MIA.

MeetStream owns meeting transport: joining, admission state, audio capture, transcription, meeting chat/audio output, and lifecycle events. Hermes owns reasoning, tools, memory, and the participant-facing answer. This bridge joins those systems through public MeetStream APIs and Hermes's authenticated OpenAI-compatible API; it does not import or depend on Hermes internals.

For a non-technical setup guide, read [QUICKSTART.md](QUICKSTART.md).

## Plug-and-play start

This example follows the MeetStream Labs convention: clone it, fill in one environment file, and use one command.

```bash
npm install
npm run setup
# Edit .env with MEETSTREAM_API_KEY, NGROK_AUTHTOKEN, and MEETING_URL.
# HERMES_API_KEY can be omitted when ~/.hermes/.env has API_SERVER_KEY.
npm run doctor
npm start
```

`npm start` validates both upstream services, starts the local bridge, creates the ngrok tunnel, creates or reuses the MIA configuration, sends the bot into the meeting, prints live counters, and removes the bot on Ctrl+C. A detached one-bot cleanup guard also sends the removal request if the terminal is closed or the launcher crashes. Override the saved meeting without editing `.env`:

```bash
npm start -- 'https://meet.google.com/abc-defg-hij'
```

By default, Hermes responds only when a completed spoken turn begins with one of these wake phrases: **“hey assistant,” “hey hermes,” “hey bot,” “okay agent,”** or **“okay bot.”** For example: “Hey Hermes, summarize the last decision.”

## System boundary

```text
Participant speech
       │
       ▼
Google Meet / Zoom / Teams
       │
       ▼
MeetStream bot + MIA
       │
       ├── lifecycle webhook ────────────────┐
       ├── finalized transcription webhook ─┤
       ├── control WebSocket ────────────────┤
       └── live-audio WebSocket ─────────────┤
                                             ▼
                                      Node.js bridge
                                             │
                                             │ Bearer-authenticated
                                             │ OpenAI-compatible request
                                             ▼
                                      Hermes gateway
                                             │
                                             │ assistant text
                                             ▼
                                      Node.js bridge
                                             │
                                             │ MeetStream `sendmsg`
                                             ▼
                                      Meeting chat
```

The stable external-agent boundary is Hermes HTTP, not Hermes's Python classes, tool implementation, or storage format. Another agent runtime can replace `Bridge.askHermes` while the meeting layer remains unchanged.

## Responsibilities

| Component | Responsibilities |
| --- | --- |
| Meeting platform | Hosts the human call and exposes its native lobby, microphone, and chat experience. |
| MeetStream bot | Joins the call, records/captures media, posts chat, plays audio, and emits lifecycle state. |
| MIA | Supplies the configured transcription pipeline and agent transport context. |
| Bridge | Correlates sessions, validates input, receives finalized turns, invokes Hermes, handles cancellation/deduplication, and returns output through MeetStream. |
| Hermes gateway | Runs the agent loop, model, tools, memory, and produces the final answer. |
| ngrok or production ingress | Gives MeetStream public HTTPS and WSS access to the locally hosted bridge. |

## End-to-end sequence

### 1. Bridge startup

`src/server.ts` loads `.env`, starts Fastify, and listens on `HOST:PORT`.

- If `PUBLIC_BASE_URL` is set, the bridge uses that origin.
- Otherwise it loads `@ngrok/ngrok`, authenticates with `NGROK_AUTHTOKEN`, and opens a tunnel to `PORT`.
- The resulting HTTPS origin is converted to WSS when bot WebSocket URLs are generated.
- `GET /health` reports both local readiness and the effective public URL.

### 2. Session creation

`POST /v1/meeting-sessions` validates the request with Zod:

- The URL must belong to Google Meet, Zoom, or Microsoft Teams.
- MeetStream and Hermes secrets must be non-empty.
- Timeouts and speech sample rates are bounded.
- Voice/hybrid output requires a speech endpoint.

The bridge selects an existing MIA configuration by ID, reuses one by name, or creates the default `Hermes External Runtime` configuration.

It then calls MeetStream `POST /api/v1/bots/create_bot` with:

- `meeting_link` and bot identity;
- `agent_config_id`;
- randomized control and audio WebSocket paths;
- a lifecycle callback;
- a live-transcription callback;
- Deepgram streaming transcription settings;
- automatic-leave settings;
- an idempotency key and bridge session ID in `custom_attributes`.

### 3. Meeting admission and transport connection

Google Meet and some Zoom/Teams configurations can place the bot in a waiting room. A host must admit it. Lifecycle events update the bridge from `joining` to `waiting_room`, then `in_meeting`.

MeetStream opens two WSS connections:

- Control: JSON handshake/events in both directions.
- Audio: handshake followed by raw binary meeting audio frames.

MeetStream's live behavior prepends the bot ID to configured WebSocket paths. The bridge therefore accepts both forms:

```text
/ws/meetstream/control/:token
/:botId/ws/meetstream/control/:token
/ws/meetstream/audio/:token
/:botId/ws/meetstream/audio/:token
```

The prefixed form verifies that the path bot ID matches the handshake bot ID. A random UUID token additionally binds the connection to the exact bridge session.

The handshake is:

```json
{
  "type": "ready",
  "bot_id": "..."
}
```

The bridge responds using MeetStream's command contract:

```json
{
  "command": "ack",
  "bot_id": "...",
  "message": "control channel bound"
}
```

### 4. Finalized participant turn

The primary turn source is MeetStream live transcription:

```text
POST /webhooks/meetstream/transcription
```

The bot is configured with `deepgram_streaming`, sentence mode, punctuation, smart formatting, VAD, and `end_of_turn` detection. Partial events are acknowledged but ignored by the agent. Only `end_of_turn: true` becomes a Hermes turn.

The bridge accepts MeetStream's control-socket `usermsg` event as a compatible secondary path. Both inputs enter the same `Bridge.accept` method and therefore share deduplication, cancellation, history, and output behavior.

Google Meet chat messages are not a Hermes input. The user must speak; Hermes's answer is posted into chat.

### 5. Hermes request

The adapter first calls:

```text
POST {hermes.base_url}/responses
Authorization: Bearer {hermes.api_key}
```

Representative request:

```json
{
  "model": "hermes-agent",
  "input": "[Alice] What did we decide?",
  "instructions": "You are participating in a live meeting...",
  "conversation": "meetstream:<bot-id>",
  "store": true
}
```

The participant name is included in the input. The stable `meetstream:<bot-id>` conversation identifier lets Hermes scope state to a meeting.

When `hermes.mode` is `auto`, HTTP 404 or 405 from `/responses` triggers a fallback to:

```text
POST {hermes.base_url}/chat/completions
```

The fallback sends the system instructions plus the latest 40 user/assistant history entries. `responses` and `chat_completions` modes force one API shape and do not automatically switch.

Each Hermes request combines:

- a per-turn cancellation signal; and
- the configured `hermes.timeout_seconds` deadline.

A newer finalized turn aborts the older turn. An inbound MeetStream `interrupt` also aborts Hermes and asks MeetStream to clear queued audio.

### 6. Meeting output

Chat output uses the cross-platform control command:

```json
{
  "command": "sendmsg",
  "bot_id": "...",
  "message": "Hermes's answer",
  "msg": "Hermes's answer"
}
```

Both `message` and `msg` are included because MeetStream's platform implementations consume different fields. If the control socket is unavailable, the bridge falls back to:

```text
POST /api/v1/bots/:botId/send_message
```

Voice output calls an OpenAI-compatible `/audio/speech` endpoint, requests headerless PCM16, splits it into approximately one-second chunks, base64-encodes each chunk, and emits MeetStream `sendaudio` commands. MeetStream carries those bytes into the meeting. MIA's public external-control contract accepts audio bytes rather than a text-to-speech instruction, so voice/hybrid mode requires a separate `speech` object.

## Session state and diagnostics

Sessions are held in memory and indexed by bridge session ID, random transport token, and MeetStream bot ID.

The management response intentionally excludes secrets and exposes:

```json
{
  "state": "in_meeting",
  "lifecycle_event": "bot.recording",
  "last_error": null,
  "transport": {
    "control_connected": true,
    "audio_connected": true,
    "control_events": 3,
    "finalized_turns": 1,
    "hermes_responses": 1,
    "last_control_event": "sendmsg"
  }
}
```

Use the counters to locate a failure:

| Observation | Likely boundary |
| --- | --- |
| Bot remains `waiting_room` | A meeting host has not admitted it. |
| Both socket flags are false | WSS URL, ingress, route, or bot connection problem. |
| Sockets connected but `finalized_turns` stays zero | No finalized speech, live-transcription configuration/provider problem, or user only typed in chat. |
| Turns increase but `hermes_responses` does not | Hermes authentication, reachability, timeout, model, or tool-loop failure. Check `last_error`. |
| Responses increase but chat is empty | MeetStream control/output problem. Verify `sendmsg` support and bot state. |

Finalized event IDs are deduplicated. When no event ID exists, a SHA-256 key is derived from bot, speaker, text, and timestamp. The bridge retains at most 512 deduplication keys per session.

## Lifecycle mapping

| MeetStream event | Bridge state |
| --- | --- |
| `bot.scheduled`, `bot.joining` | `joining` |
| `bot.in_waiting_room` | `waiting_room` |
| `bot.inmeeting` | `in_meeting` |
| `bot.leaving` | `leaving` |
| `bot.stopped`, `bot.kicked` | `stopped` |
| `bot.failed`, `bot.denied`, `bot.notallowed` | `failed` |

Other lifecycle events, such as `bot.recording`, are retained as `lifecycle_event` while the current state remains unchanged. Terminal states cancel an active Hermes turn.

## Management API

If `BRIDGE_API_KEY` is set, every `/v1/*` route requires:

```text
X-Integration-Key: <BRIDGE_API_KEY>
```

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Readiness and public origin. |
| `POST` | `/v1/meeting-sessions` | Resolve MIA, create bot, and return session. |
| `GET` | `/v1/meeting-sessions` | List in-memory sessions. |
| `GET` | `/v1/meeting-sessions/:id` | Inspect lifecycle and transport counters. |
| `POST` | `/v1/meeting-sessions/:id/stop` | Remove that exact MeetStream bot. |
| `POST` | `/webhooks/meetstream` | Receive lifecycle events. |
| `POST` | `/webhooks/meetstream/transcription` | Receive live transcription; finalized turns invoke Hermes. |

## Session request schema

Minimal request:

```json
{
  "meeting_url": "https://meet.google.com/abc-defg-hij",
  "hermes": {
    "base_url": "http://127.0.0.1:8080/v1",
    "api_key": "your-hermes-api-server-key"
  },
  "meetstream": {
    "api_key": "your-meetstream-api-key"
  }
}
```

Expanded shape:

```json
{
  "meeting_url": "https://meet.google.com/abc-defg-hij",
  "hermes": {
    "base_url": "http://127.0.0.1:8080/v1",
    "api_key": "secret",
    "model": "hermes-agent",
    "mode": "auto",
    "instructions": "Answer concisely for meeting participants.",
    "timeout_seconds": 90
  },
  "meetstream": {
    "base_url": "https://api.meetstream.ai",
    "api_key": "secret",
    "mia": {
      "agent_config_id": "optional-existing-id",
      "reuse_by_name": true
    },
    "bot_name": "Hermes Meeting Agent",
    "bot_message": "Hermes has joined the meeting.",
    "video_required": false,
    "automatic_leave": {
      "waiting_room_timeout": 600,
      "everyone_left_timeout": 120,
      "voice_inactivity_timeout": 600,
      "in_call_recording_timeout": 14400,
      "recording_permission_denied_timeout": 60
    }
  },
  "output": "chat"
}
```

For `voice` or `hybrid`, add:

```json
{
  "speech": {
    "base_url": "https://speech-provider.example/v1",
    "api_key": "secret",
    "model": "tts-1",
    "voice": "alloy",
    "sample_rate": 24000,
    "timeout_seconds": 60
  }
}
```

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `NGROK_AUTHTOKEN` | When `PUBLIC_BASE_URL` is absent | ngrok credential used by the embedded tunnel. |
| `NGROK_DOMAIN` | No | Stable reserved ngrok domain. Temporary domains may change after restart. |
| `PUBLIC_BASE_URL` | Production alternative to ngrok | Existing public HTTPS origin. Setting it disables embedded ngrok. |
| `BRIDGE_API_KEY` | Recommended for server mode | Secret protecting `/v1/*`; generate it yourself. It is not issued by MeetStream or Hermes. |
| `MIA_HERMES_WEBHOOK_SECRET` | Optional | HMAC secret for signed lifecycle webhooks when signing is enabled in MeetStream. |
| `MEETSTREAM_API_KEY` | Yes | MeetStream API key from the dashboard. |
| `MEETSTREAM_MIA_CONFIG_ID` | Optional | Existing MIA configuration to attach. If omitted, the bridge resolves/creates one. |
| `HERMES_GATEWAY_URL` | No | Defaults to `http://127.0.0.1:8080/v1`. |
| `HERMES_API_KEY` | Required unless found in `~/.hermes/.env` | Bearer key for Hermes. |
| `HERMES_MODEL` | No | Defaults to `hermes-agent`. |
| `HERMES_API_MODE` | No | `auto` (default), `responses`, or `chat_completions`. |
| `MEETING_URL` | Required by zero-argument start | Google Meet, Zoom, or Teams URL. A CLI URL overrides it. |
| `BOT_NAME` | No | Display name; defaults to `Hermes Meeting Agent`. |
| `WAKE_WORDS` | No | Comma-separated activation phrases. Defaults to `hey assistant,hey hermes,hey bot,okay agent,okay bot`. Set `off` to respond to every finalized turn. |
| `OUTPUT_MODE` | No | `chat` (default), `voice`, or `hybrid`; voice modes also require speech variables. |
| `HOST` | No | Local bind host; defaults to `127.0.0.1`. Compose overrides it to `0.0.0.0`. |
| `PORT` | No | Local port; defaults to `3000`. |

`MIA_HERMES_API_KEY` is accepted only as a deprecated compatibility alias. New installations should use separate `MEETSTREAM_API_KEY` and `BRIDGE_API_KEY` values so a management credential leak cannot grant MeetStream account access.

## Hermes gateway setup

Hermes enables its API server when a strong `API_SERVER_KEY` is present. A typical `~/.hermes/.env` contains:

```dotenv
API_SERVER_KEY=<at-least-16-character-random-secret>
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8080
```

Generate a secret with:

```bash
openssl rand -hex 32
```

Install/start the supervised gateway:

```bash
hermes gateway install
hermes gateway status
```

Verify it without printing the secret:

```bash
curl http://127.0.0.1:8080/health
```

### Find the Hermes URL and port

`http://127.0.0.1:8080/v1` is only the default. Hermes can use a different port if its own configuration says so. Check the running service first:

```bash
hermes gateway status
```

Then read only its host and port settings (this deliberately does not print `API_SERVER_KEY`):

```bash
rg '^API_SERVER_(HOST|PORT)=' ~/.hermes/.env
```

For example, `API_SERVER_HOST=127.0.0.1` and `API_SERVER_PORT=9000` means:

```dotenv
HERMES_GATEWAY_URL=http://127.0.0.1:9000/v1
```

If Hermes runs on another machine, use that machine's reachable host instead, for example `http://192.168.1.50:8080/v1`. The bridge host must be able to reach Hermes. Keeping Hermes on loopback is appropriate when both processes run on the same machine.

## MIA configuration

Supplying `meetstream.mia.agent_config_id` is the most deterministic production setup. Without it, the bridge lists configurations, reuses one whose name is `Hermes External Runtime`, or creates a pipeline configuration containing:

- Deepgram `nova-3` transcription;
- a minimal built-in model entry required by MIA's public schema;
- action/no-response behavior so Hermes remains the participant-facing runtime;
- 24 kHz mono audio metadata.

MIA currently requires built-in provider fields even though Hermes supplies the external reasoning loop. Provider integrations referenced by MIA and live transcription must exist in the MeetStream account.

The built-in model prompt says not to produce a participant-facing response. That prevents the meeting layer from becoming coupled to a second reasoning agent.

## Wake words

Wake-word gating is enforced in the bridge, after MeetStream has delivered a finalized transcription and before Hermes is called. It is therefore independent of MIA's built-in-provider configuration and works the same for Google Meet, Zoom, and Teams.

The default phrases are `hey assistant`, `hey hermes`, `hey bot`, `okay agent`, and `okay bot`. Matching is case-insensitive and accepts ordinary punctuation—including Meet captions such as `Hey, assistant`—but the phrase must begin the participant turn. The bridge strips the phrase before passing the request to Hermes, so Hermes receives `summarize the last decision`, not `Hey Hermes, summarize the last decision`.

Set `WAKE_WORDS` to a comma-separated list to replace the defaults. Set `WAKE_WORDS=off` to deliberately disable gating and invoke Hermes for every finalized spoken turn.

MIA dashboard wake words are a separate feature and must remain disabled for this external-runtime architecture. MIA's job here is to deliver transcripts; the bridge owns wake-word gating and calls Hermes. Do not try to duplicate `WAKE_WORDS` in the MeetStream Agents UI.

Google Meet can combine multiple spoken sentences into one finalized caption. When that happens, the bridge selects the last sentence that begins with a wake phrase. For predictable answers, say one wake phrase, ask one question, then pause for the reply instead of repeating several questions in one speaking turn.

## Quick start for developers

Requirements:

- Node.js 20.12 or newer;
- a running authenticated Hermes gateway;
- MeetStream and ngrok credentials;
- a joinable meeting URL;
- Deepgram configured in MeetStream for live streaming transcription.

```bash
npm install
npm run setup
npm run doctor
npm start
```

That single process runs the server, tunnel, and bot. A URL argument overrides `MEETING_URL`:

```bash
npm start -- 'https://meet.google.com/abc-defg-hij'
```

Admit the bot when the meeting platform requests it, then speak. Do not test by typing in Google Meet chat; chat is output-only in this integration. Press Ctrl+C to remove the bot and close the tunnel.

For an always-on or multi-session deployment, start the management server instead:

```bash
npm run build
npm run start:server
```

Then create sessions through `POST /v1/meeting-sessions`; `npm run launch -- <meeting-url>` remains as a convenience client for that advanced mode.

## Tests and verification

```bash
npm run check
npm audit --audit-level=high
npm run verify:postman -- /absolute/path/to/Meetstream.postman_collection.json
```

The test suite covers:

- supported meeting URL validation;
- voice configuration validation;
- MIA selection/creation and bot payloads;
- standard and bot-ID-prefixed WebSocket paths;
- handshake acknowledgements;
- direct `usermsg` turns;
- finalized live-transcription webhook turns;
- Hermes Responses parsing;
- Chat Completions fallback;
- `sendmsg` and PCM audio output;
- management authentication;
- lifecycle webhook HMAC verification.

Tests use fake MeetStream, Hermes, and speech services and do not launch a real bot. The Postman verifier checks the supplied collection's relevant endpoint contracts and SHA-256 fingerprint.

## Security model

### Secrets

- `.env` is ignored by Git and Docker build context.
- Request/response views do not expose MeetStream, Hermes, speech, or management keys.
- Hermes keys remain in memory for the lifetime of their meeting session.
- Keep Hermes private when possible; it may expose powerful tools, filesystem access, browser access, and memory.

### Public routes

MeetStream must reach the lifecycle callback, transcription callback, and WSS paths without browser login, OAuth redirect, or an ngrok interstitial. Public transport paths are protected by high-entropy per-session tokens and bot-ID binding.

### Webhook verification

When `MIA_HERMES_WEBHOOK_SECRET` is set, lifecycle callbacks require:

```text
X-MeetStream-Signature: sha256=<HMAC-SHA256(raw-request-body)>
```

The live-transcription callback currently relies on the random bot/session correlation and network controls because MeetStream's live-transcription guide does not document the same signature header. Put the bridge behind rate limiting and ingress filtering in production.

### Data sensitivity

Participant speech, transcripts, tool results, and answers may contain sensitive information. This service does not intentionally persist them, but MeetStream, Hermes, model providers, logs, and infrastructure can have their own retention behavior. Configure those systems to match organizational policy.

## Failure handling

- MeetStream and MIA HTTP calls have 30-second deadlines.
- Hermes and speech use request-specific configured deadlines.
- Non-JSON or failed upstream responses become structured bridge errors.
- A failed turn posts a short retry message when possible and stores the underlying message in `last_error`.
- Session creation is rolled back locally if bot creation fails.
- SIGINT/SIGTERM attempts to remove every known bot before closing ingress.
- Webhook handlers acknowledge quickly; Hermes runs asynchronously after a finalized turn.

## Troubleshooting

### Bot never joins

- Confirm the meeting URL is active and supported.
- Inspect `state` and `lifecycle_event` through the management API.
- Admit the bot from the platform waiting room.
- Check MeetStream's bot detail/status endpoint for denial, rejection, or container handoff.

### Bot joins but Hermes never answers

Inspect `transport` in the session response.

1. Both sockets must be connected.
2. `finalized_turns` must increase after speech.
3. `hermes_responses` must increase afterward.
4. `last_error` must remain null.

Typed Meet chat does not create a turn. Speak and pause long enough for end-of-turn detection.

### MeetStream gets WebSocket 404

MeetStream can prefix the bot ID to the supplied path. Both route forms are implemented. If an ingress proxy rewrites paths, preserve the complete path and WebSocket upgrade headers.

### Hermes returns 401

The request's `hermes.api_key` must exactly match Hermes `API_SERVER_KEY`. Verify the gateway is listening and test `/health` and `/v1/models` locally.

### Response counter rises but no chat appears

The bridge uses `sendmsg` with both `message` and `msg`. Confirm the control socket is still connected, meeting chat is enabled, and the bot is still in the meeting. The REST `send_message` fallback is used only when no control socket is available.

### ngrok URL changes

Use `NGROK_DOMAIN` for a reserved domain or deploy behind a stable `PUBLIC_BASE_URL`. Existing bots retain the callback/WSS URLs supplied when they were created.

## Production considerations

This repository is a reference implementation, not a horizontally scalable session store.

- Sessions, history, tokens, counters, and socket references are process-local.
- Restarting the bridge loses local session correlation; remove existing bots before restart.
- Multiple replicas require shared session metadata and sticky WebSocket routing.
- Use a stable ingress rather than a temporary ngrok URL.
- Add centralized structured logs and metrics without logging transcripts or secrets by default.
- Add durable idempotency if webhook processing spans replicas.
- Review MeetStream/provider retention and regional requirements.
- Rotate all credentials and use a secret manager.
- Restrict management routes separately from public MeetStream transport routes.

## Docker

```bash
docker compose up --build
```

The image builds TypeScript in a Node 22 build stage, installs production dependencies in a slim runtime stage, runs as the non-root `node` user, and exposes port 3000. Compose uses a read-only filesystem, a temporary `/tmp`, and `no-new-privileges`.

Set `PUBLIC_BASE_URL` when deploying the container behind production ingress. Running an embedded ngrok tunnel inside the container is convenient for development but not the preferred production topology.

## Repository map

```text
src/config.ts               Local environment loading and connectivity preflight
src/schema.ts               Input validation, defaults, platform detection
src/bridge.ts               Session state, MeetStream client, Hermes adapter, output
src/server.ts               Fastify HTTP/WSS routes, auth, ngrok, shutdown
scripts/run.ts              One-command local server, tunnel, bot, status, cleanup
scripts/cleanup-guard.ts    Crash/terminal-close fallback for one launched bot
scripts/setup.ts            Non-destructive .env bootstrap
scripts/doctor.ts           Read-only local and upstream preflight
scripts/launch.ts           Advanced server-mode meeting launcher
scripts/verify-postman.ts   Supplied Postman collection contract check
test/bridge.test.ts         Deterministic integration tests
examples/create-session.json Full manual management request example
.env.example                Configuration template
Dockerfile                  Production image
compose.yaml                Local container orchestration
QUICKSTART.md               Non-technical operating guide
```

## Reference sources

- [MeetStream live meeting chat-agent walkthrough](https://meetstream.ai/blog/how-to-build-a-live-meeting-chat-agent/)
- [MeetStream MIA configurations](https://docs.meetstream.ai/guides/mia/mia-configurations)
- [MeetStream live transcription](https://docs.meetstream.ai/guides/transcription-recordings/live-transcription)
- [MeetStream bridge architecture](https://docs.meetstream.ai/guides/websockets/bridge-server-architecture)
- [MeetStream meeting control commands](https://docs.meetstream.ai/guides/websockets/meeting-control-patterns)
- [ngrok JavaScript agent SDK](https://ngrok.com/docs/getting-started/javascript)
