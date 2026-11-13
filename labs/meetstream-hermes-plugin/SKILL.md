---
name: meetstream
description: MeetStream plugin for Hermes. Use it to list MIA configurations and join, inspect, list, or leave Google Meet, Zoom, and Microsoft Teams meetings through natural-language requests.
---

# MeetStream plugin

The MeetStream plugin includes a Hermes-native skill plus the `bridge/` runtime. The skill is the natural-language management surface. The bridge owns public MeetStream callbacks, WebSocket transport, Hermes requests, wake-word gating, deduplication, cancellation, and chat/audio output.

## Install and run

Run `./install.sh` from this distribution to install it as `~/.hermes/skills/meetstream/`. The installer refuses to overwrite an existing installation. Hermes discovers the plugin from its `SKILL.md` frontmatter.

From the distribution root:

```sh
cd bridge
npm install
npm run setup
# Edit .env, then verify without starting a bot:
npm run doctor
# Start plugin management mode without creating a bot:
npm run plugin
```

The bridge requires Node.js 20.12+, a running authenticated Hermes gateway, a MeetStream API key, and public HTTPS/WSS ingress through ngrok or `PUBLIC_BASE_URL`. `npm run plugin` starts the management server and does not create a bot. `npm start` remains an optional one-meeting demo that immediately sends a bot to `MEETING_URL`.

Use the bundled `scripts/meetstream.py` CLI. It talks to the bridge management API; it does not import Hermes internals or call MeetStream directly.

## Configuration

Configure MeetStream and Hermes credentials only in `bridge/.env`. The skill does not receive or transmit those upstream secrets. In the Hermes process environment set only:

- `MEETSTREAM_BRIDGE_URL`: bridge origin, default `http://127.0.0.1:3000`
- `MEETSTREAM_BRIDGE_KEY`: the same value as the required `BRIDGE_API_KEY` in `bridge/.env`

Do not put secrets in prompts, command arguments, logs, or card comments.

## Commands

Run commands from this skill directory:

```sh
python3 scripts/meetstream.py health
python3 scripts/meetstream.py join https://meet.google.com/abc-defg-hij
python3 scripts/meetstream.py sessions
python3 scripts/meetstream.py mia-list
python3 scripts/meetstream.py inspect SESSION_ID
python3 scripts/meetstream.py leave SESSION_ID
```

`join` accepts Google Meet, Zoom, and Microsoft Teams URLs. It creates a chat-output session with wake-word gating enabled by the bridge defaults. Say “Hey Hermes” (or another configured wake phrase) aloud in the meeting; typed meeting chat is output-only.

Map natural-language intent deterministically:

- “Join this meeting as my Hermes agent” → `join URL`
- “List my active meeting bots” → `sessions`
- “List my MIA configurations” → `mia-list`
- “Show the status of this bot” → `inspect SESSION_ID`
- “Remove the bot from the call” → `leave SESSION_ID`

Before joining, confirm the exact meeting URL and that the user wants a bot sent into that meeting. Before `leave`, confirm the session ID if more than one session is active. Treat `leave` as an external side effect and do not run it merely to inspect status.

## Behavior and safety

- Prefer `health`, `sessions`, `mia-list`, and `inspect` for read-only status checks.
- Never print response bodies that may contain credentials. The CLI redacts keys recursively.
- A failed or non-JSON bridge response becomes a concise error with its HTTP status.
- The CLI only uses documented bridge routes. MeetStream and Hermes credentials remain server-side.
- Voice and hybrid output are intentionally not exposed by this skill until an explicit speech configuration is available.

## Reference boundary

The bridge follows the public `meetstream-ai/labs/mia-hermes-bridge` contract: Hermes is an authenticated OpenAI-compatible HTTP runtime, while MeetStream MIA owns meeting transport, transcription, lifecycle events, and chat/audio output. A skill alone can safely perform management calls, but it cannot receive MeetStream webhooks or maintain the required bidirectional WebSocket streams. That precise runtime requirement is why this plugin includes the bridge rather than a custom in-process Hermes tool.
