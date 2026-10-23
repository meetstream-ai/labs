# MIA × OpenClaw meeting bridge

This reference integration puts a self-hosted OpenClaw agent into a Google Meet, Zoom, or Microsoft Teams meeting through MeetStream MIA. MeetStream owns meeting transport, transcription, lifecycle, chat, and audio. OpenClaw remains the agent runtime that selects the model, tools, and memory.

## Architecture

```text
participant speech → MeetStream MIA → finalized transcription webhook
                                      ↓
                              meeting-scoped bridge
                                      ↓ Bearer-authenticated
                         OpenClaw Gateway /v1/chat/completions
                                      ↓
                         MeetStream control WebSocket
                              chat and optional voice
```

The bridge uses OpenClaw's agent-first model contract (`openclaw/default` or `openclaw/<agentId>`) and sends `user=meetstream:<bot_id>` so Gateway conversation state is scoped to one meeting. OpenClaw's Chat Completions endpoint is disabled by default and uses the Gateway's trusted operator security boundary; enable it only on a private, authenticated Gateway.

## Quick start

```bash
cd labs/mia-openclaw-bridge
npm install
npm run setup
# edit .env with the values below
npm run doctor
npm start
```

Required configuration:

```dotenv
MEETSTREAM_API_KEY=...
MEETING_URL=https://meet.google.com/abc-defg-hij
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789/v1
OPENCLAW_GATEWAY_TOKEN=...
OPENCLAW_MODEL=openclaw/default
NGROK_AUTHTOKEN=...
```

Use `PUBLIC_BASE_URL` instead of `NGROK_AUTHTOKEN` when the bridge already has public HTTPS/WSS ingress. `MEETSTREAM_MIA_CONFIG_ID` is optional: the bridge reuses the named **OpenClaw External Runtime** configuration or creates the transport-only pipeline configuration through the MIA API.

The default wake phrases are “Hey OpenClaw”, “Hey Assistant”, “Hey Bot”, “Okay Agent”, and “Okay Bot”. Set `WAKE_WORDS=off` to process every finalized turn. The local launcher removes the MeetStream bot on Ctrl+C and installs a cleanup guard for interrupted runs.

## Security boundary

- Never expose the OpenClaw Gateway directly to the public internet.
- Treat `OPENCLAW_GATEWAY_TOKEN` as an operator credential, not a user token.
- Keep `BRIDGE_API_KEY` separate from the MeetStream API key; it protects the bridge's management endpoints.
- Keep webhook signing enabled with `MEETSTREAM_WEBHOOK_SECRET` when supported.
- The bridge accepts only Google Meet, Zoom, and Microsoft Teams HTTPS links.
- Finalized turns are deduplicated and queued per meeting session.
- No upstream credentials are returned by bridge status endpoints.

## Verification

```bash
npm run check
```

The suite type-checks, exercises MIA creation and bot payloads, verifies OpenClaw Chat Completions routing and meeting-scoped `user` values, tests finalized-turn webhooks, wake-word gating, cleanup, WebSockets, auth, and webhook signatures. It uses only local fakes; it does not join a real meeting.

For a live test, you need an OpenClaw Gateway configured with `gateway.http.endpoints.chatCompletions.enabled: true`, a Gateway token, a MeetStream API key, public HTTPS/WSS ingress, and a real meeting link. A host must admit the bot in the meeting.
