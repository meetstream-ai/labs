# AGENTS.md

Guidance for AI coding agents working in this repository. This repo is the **MeetStream plugin for Hermes Agent**. It is a declarative [Agent Plugins v1](https://agent-plugins.org/specification) package that connects Hermes to the hosted MeetStream MCP server and ships six skills.

## What this repo is, and is not

- **Is:** `plugin.json` (manifest), `mcp.json` (one remote MCP server), `skills/*/SKILL.md`, docs, a demo script and a check script.
- **Is not:** a MeetStream client, bridge, proxy or audio pipeline. Meeting transport, audio, chat and bot lifecycle belong to MeetStream, and the API surface belongs to [`meetstream-mcp`](https://github.com/meetstream-ai/meetstream-mcp). If a capability is missing, add it to the MCP server, not here. `scripts/check.py` fails on server or socket code.
- Hermes as the in-meeting voice (meeting → Hermes) is [`labs/mia-hermes-bridge`](https://github.com/meetstream-ai/labs/tree/main/mia-hermes-bridge). Do not duplicate it here.

## Why `plugin.json` and not `plugin.yaml`

Hermes has two plugin formats. Native `plugin.yaml` + `register(ctx)` plugins cannot declare MCP servers. The Agent Plugins v1 adapter (`hermes_cli/agent_plugins.py`) is the only native way for a standalone repo to ship an MCP connection plus skills. If a `plugin.yaml` is ever added, Hermes ignores `plugin.json` and the MCP connection disappears.

## Rules Hermes enforces on this package

- `plugin.json` may contain only `$schema`, `name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, `extensions`, and `$schema` must be `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`.
- `mcp.json` must contain exactly `$schema` (`…/1.0.0/mcp.schema.json`) and `mcpServers`. Remote entries are `type: "streamable-http"` with only `url` and `headers`. `sse` is rejected.
- The server name `meetstream` is the tool prefix: `mcp__meetstream__<tool>`. Renaming it breaks every skill.
- The plugin name `meetstream` fixes the skill namespace `agent-plugin-meetstream-ee716565`. Renaming it changes the namespace used by `scripts/demo.sh`.
- Skill frontmatter `name` must equal the directory name, and `description` must be 1-1024 characters.

## Auth

- The MCP server takes **`Authorization: Bearer <key>`**. The REST API takes `Token`. Mixing them up returns 401.
- The header value is the placeholder `Bearer ${MEETSTREAM_API_KEY}`. Hermes resolves it at connect time from the environment or `~/.hermes/.env`, and refuses to connect if it is unset.
- Never put a real key in any file. Never ask the user to paste a key into chat.

## Skill rules

- Describe only tools the MCP server exposes. `python3 scripts/check.py --live` compares tool references against the real server's `tools/list`.
- MIA agent configs, calendar connection, signed-in account management, Zoom ZAK/OBF setup, custom storage and pause/resume are **REST-only**. Name them as such and route to REST, the dashboard or `@meetstream/cli`. Never imply a tool exists.
- There is no MCP tool that makes the bot say arbitrary text. Speech is MIA (`agent_config_id`). Do not write a skill that claims otherwise.
- MIA bots take **only** `agent_config_id`. Never add `socket_connection_url` / `live_audio_required`.
- Video is off by default (`record_video` unset). Per-participant video is opt-in only.
- Keep skills short and imperative. They are read by an agent mid-task.

## Before you finish

```sh
python3 scripts/check.py --live
```

All checks must pass. State what you changed, which MCP tools you relied on, and what you could not verify (anything needing a real key or a real meeting).

## Related

- MCP server: https://github.com/meetstream-ai/meetstream-mcp
- Cursor plugin (skill source): https://github.com/meetstream-ai/meetstream-cursor-plugin
- Claude Code plugin: https://github.com/meetstream-ai/claude-plugin
- Hermes plugin docs: https://hermes-agent.nousresearch.com/docs/developer-guide/plugins
