---
name: meetstream
description: Build and operate MeetStream meeting bots: recording, transcription, MIA agents, calendar scheduling, live chat, transcripts, summaries, media, and lifecycle management.
homepage: https://docs.meetstream.ai
metadata: { "openclaw": { "emoji": "🎙️", "requires": { "bins": ["curl", "jq"] }, "primaryEnv": "MEETSTREAM_API_KEY" } }
---

# MeetStream

> Non-technical install/usage guide: [QUICKSTART.md](./QUICKSTART.md)
> Full technical reference: [README.md](./README.md)

Control [MeetStream](https://meetstream.ai) meeting bots and MIA (MeetStream
Infrastructure Agent) voice agents through its REST API
(`https://api.meetstream.ai/api/v1`). Use the scripts in `{baseDir}/scripts/`
for every operation below — do not call `curl` against the MeetStream API
directly, and never print or log the raw value of `MEETSTREAM_API_KEY`.

All scripts read the key from the `MEETSTREAM_API_KEY` environment variable
and exit with a clear error (exit code 78) if it is missing. They print a
human-readable summary by default; pass `--json` to get the raw API response
for further processing.

## When to use this skill

Use it whenever the user asks to work with meeting bots or MIA agents in
natural language, for example:

- "send my agent to this meeting" / "join this call with the standup bot"
- "show me the MIA agents I can use" / "which agents do I have set up"
- "what bots are in a call right now" / "is the bot still in the meeting"
- "remove the bot from the current call" / "pull the bot out of that meeting"
- "check on bot <id>"
- "build me a post-call notetaker" / "stream captions to my webhook"
- "get the transcript or summary from that meeting"
- "who attended" / "show the meeting chat" / "get the recording"
- "send this message into the meeting"
- "schedule a bot for this calendar event"

## Commands

### List available MIA agents

```bash
{baseDir}/scripts/list-agents.sh
```

Shows each agent's name, `AgentConfigID`, mode (`realtime`/`pipeline`), and
model. Run this before `send-bot.sh` whenever the user names an agent so you
can confirm which config they mean, or let `send-bot.sh --agent-name` resolve
it for you (see below).

### Send a bot (optionally with an agent) into a meeting

```bash
{baseDir}/scripts/send-bot.sh --link "<meeting_url>" --name "<bot display name>" [options]
```

Key options: `--agent-id ID` or `--agent-name TEXT` (fuzzy-matched against
`list-agents.sh`, case-insensitive substring — the script refuses to guess
and lists candidates if the name is ambiguous), `--video`/`--no-video`
(default: video on), `--message TEXT` (chat message on join), `--join-at
ISO8601` (schedule instead of joining now), `--attr KEY=VALUE` (repeatable
custom metadata), `--transcription PROVIDER`, `--language CODE`,
`--retention-hours N`, `--separate-audio`, `--separate-video`,
`--live-transcript URL`, `--idempotency-key UUID`, and `--json`.

For a Hosted MIA, pass only `agent_config_id`; do not add custom bridge
WebSocket URLs. For bot architecture choices and recipes, read
`{baseDir}/references/BOT-BUILDING.md` or route to the focused
`meetstream-bot-builder` / `meetstream-notetaker` skills.

**Before running this:** confirm you have an actual meeting URL (Zoom /
Google Meet / Microsoft Teams) from the user's message or context — never
guess or fabricate one. If the user says "this meeting" without a link, ask
for it or look for it in the current conversation/calendar context first.
Joining a meeting is a real, visible action (the bot appears as a
participant), so don't call this speculatively.

### List bots / find the current call

```bash
{baseDir}/scripts/list-bots.sh [--status S] [--platform GMeet|Zoom|Teams] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--active]
```

`--active` is a best-effort client-side filter that hides bots whose status
text looks terminal (done/stopped/left/failed/expired/removed/not-allowed).
Use it to find "the bot in the current call" when the user doesn't give a
bot ID. If it returns more than one candidate, list them for the user and
ask which one, rather than picking one yourself.

### Check a specific bot's status

```bash
{baseDir}/scripts/bot-status.sh <bot_id>
```

### Remove a bot from its meeting

```bash
{baseDir}/scripts/remove-bot.sh <bot_id>
{baseDir}/scripts/remove-bot.sh --current
```

`--current` resolves the bot via `list-bots.sh --active`. If it finds more
than one plausibly-active bot, or the API says more pages remain, it refuses
to guess, prints the available candidates, and exits non-zero — re-run with
an explicit `bot_id` in that case. This is
a real, irreversible action for that meeting session, so if the user's
request is ambiguous about *which* bot or meeting, ask before removing.

### Retrieve meeting data

```bash
{baseDir}/scripts/bot-data.sh detail|summary|participants|chats|speakers|audio|video|audio-streams|video-streams|screenshots|transcriptions <bot_id>
{baseDir}/scripts/get-transcript.sh <bot_id>
```

These operations are read-only, but their output can contain sensitive meeting
content and short-lived media URLs. Do not expose it outside the user's stated
scope. Streaming-only transcription providers use the live webhook as the
canonical transcript and may not produce a normal post-call transcript.

### Send a live meeting chat message

```bash
{baseDir}/scripts/send-chat.sh <bot_id> --message "<text>"
```

This is visible to meeting participants. Require an explicit target bot and
message; never send a speculative status or diagnostic message.

### Calendar bots

```bash
{baseDir}/scripts/calendar-bots.sh list
{baseDir}/scripts/calendar-bots.sh schedule <event_id>
{baseDir}/scripts/calendar-bots.sh unschedule <event_id>
```

Calendar connection is an administrative OAuth setup. This script operates on
an already connected calendar. Confirm the exact event before scheduling or
unscheduling a bot.

## Output conventions

- Report the `bot_id` back to the user after `send-bot.sh` so they can refer
  to "that bot" later in the conversation — keep it in context.
- On any script failure (non-zero exit), surface the script's stderr message
  to the user rather than retrying silently or inventing a different error.
- Don't fabricate meeting links, bot IDs, or agent IDs. If you don't have
  one, get it from the user, from `list-agents.sh`/`list-bots.sh` output, or
  ask — never invent one that looks plausible.

## Setup

Run `{baseDir}/install.sh` once to set this up end-to-end: it installs the
skill into your OpenClaw workspace, installs `curl`/`jq` if missing, stores
your MeetStream API key in a local `.env` (auto-loaded by every script),
runs the offline test suite, and restarts the gateway. Run
`{baseDir}/scripts/doctor.sh` any time something seems broken — it pinpoints
which of (dependencies / key / live auth / OpenClaw discovery) is failing.

Get a MeetStream API key at <https://app.meetstream.ai/api-key>. If you'd
rather scope the key through OpenClaw's own env-entry mechanism instead of
the skill's `.env` file, set it in `openclaw.json`:

```json5
{
  skills: {
    entries: {
      meetstream: {
        enabled: true,
        apiKey: { source: "env", provider: "default", id: "MEETSTREAM_API_KEY" },
      },
    },
  },
}
```
