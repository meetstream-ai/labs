---
name: meetstream-debugger
description: Diagnose MeetStream bot joins, waiting rooms, lifecycle failures, transcription readiness, MIA configuration, and missing meeting artifacts.
homepage: https://docs.meetstream.ai
metadata: { "openclaw": { "emoji": "🩺", "requires": { "bins": ["curl", "jq"] }, "primaryEnv": "MEETSTREAM_API_KEY" } }
---

# MeetStream Debugger

Start with `{baseDir}/../meetstream/scripts/doctor.sh`, then use the core
`bot-status.sh` and `bot-data.sh detail <bot-id>`. Read
`{baseDir}/../meetstream/references/WEBHOOKS.md`
before interpreting callbacks.

Common diagnoses:

- `InWaitingRoom`: the host must admit the bot.
- `NotAllowed`: waiting-room admission timed out.
- `Denied`: the host or platform rejected the bot.
- `bot.error`: usually a non-terminal streaming/provider problem.
- no transcript: inspect detail and transcriptions; streaming-only providers
  use their live webhook instead of the post-call transcript path.

Report evidence from the API. Do not retry bot creation automatically; retries
without the original idempotency key can create a duplicate visible bot.
