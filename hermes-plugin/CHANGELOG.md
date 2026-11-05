# Changelog

All notable changes to the MeetStream plugin for Hermes.

## [1.0.0] - 2026-10-06

### Added
- Agent Plugins v1 package (`plugin.json`, `mcp.json`) that Hermes Agent loads natively. It connects to the hosted MeetStream MCP server at `https://mcp.meetstream.ai/mcp` and exposes 19 tools as `mcp__meetstream__*`.
- Per-user auth: `Authorization: Bearer ${MEETSTREAM_API_KEY}`, resolved by Hermes at connect time from the environment or `~/.hermes/.env`. No key in the repo, nothing stored server-side.
- Six skills: `join-meeting`, `speak-in-meeting`, `meeting-chat`, `meeting-brief`, `calendar-bots`, `troubleshooting`. They are adapted from the MeetStream Cursor plugin and limited to capabilities the MCP server exposes.
- `examples/mia-intro-agent.json`, a MIA voice agent config that introduces the bot out loud, created with `@meetstream/cli mia create`.
- `scripts/demo.sh`, an end-to-end real-meeting demo (Hermes → MCP → bot → meeting → speech).
- `scripts/check.py`, which checks manifests, skills, relative links, tool references against the live `tools/list`, scans for secrets, guards against transport code, and runs `hermes plugins validate`/`doctor`.
- `INSTALL.md`, a step-by-step guide for the terminal and the desktop app, from install to a first real meeting, with troubleshooting.
- CI workflow running the checks.
