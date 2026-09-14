---
name: meetstream-bot-builder
description: Design and launch safe MeetStream recording, transcription, streaming, or MIA meeting bots from natural-language requirements.
homepage: https://docs.meetstream.ai
metadata: { "openclaw": { "emoji": "🤖", "requires": { "bins": ["curl", "jq"] }, "primaryEnv": "MEETSTREAM_API_KEY" } }
---

# MeetStream Bot Builder

Use this skill when the user asks to build, configure, launch, or choose an
architecture for a MeetStream bot. Read `{baseDir}/../meetstream/references/BOT-BUILDING.md`
before selecting a pattern.

Run `{baseDir}/../meetstream/scripts/doctor.sh` first. For a real launch, require an
authorized meeting URL and confirm the visible action. Prefer audio-only,
short retention, and a UUID idempotency key unless the requirements justify
more data. Use `{baseDir}/../meetstream/scripts/send-bot.sh`; never construct a raw
MeetStream request when the script supports the requested fields.

For MIA, list configurations with `list-agents.sh` and attach only the selected
`agent_config_id`. If the user needs a custom real-time media bridge, scaffold a
separate application from the official Labs patterns instead of forcing it into
the shell skill.
