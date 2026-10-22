# AGENTS.md

Guidance for AI coding agents working in this repository. Labs is a collection of **standalone, runnable MeetStream examples**. Every directory is its own self-contained project.

## Always use the MeetStream MCP

When building anything against the MeetStream API, install and use the MeetStream MCP. It is the current source of truth for endpoints, request and response fields, webhook events, provider names and bot behaviour.

Do not treat the files in this repository as authoritative for MeetStream API behaviour. They can lag the API. If local code and the MCP disagree, the MCP wins unless the user says otherwise.

Server name: `meetstream`. URL: `https://mcp.meetstream.ai/mcp`. MeetStream hosts it; there is no local install. Do not use `npx @meetstream/mcp`: that npm package is the old Node server, frozen at 0.3.0, and it predates the current defaults.

Add the URL with **no key** and sign in: the client opens app.meetstream.ai, the user clicks Allow, and the dashboard creates an API key for that connection (delete it on the API keys page to disconnect). Use an API key header only when the client cannot do OAuth.

### Claude Code

```sh
claude mcp add --transport http meetstream https://mcp.meetstream.ai/mcp
# then /mcp -> Authenticate
```

With a key instead: add `--header "Authorization: Bearer $MEETSTREAM_API_KEY"`.

The [MeetStream Claude plugin](https://github.com/meetstream-ai/claude-plugin) is a separate, complementary install. It ships **skills only** and does not include the MCP server, so install both:

```sh
/plugin marketplace add meetstream-ai/claude-plugin
```

### Claude (desktop and web)

Customize -> Connectors -> + -> Add custom connector. Name it `meetstream`, set the URL to `https://mcp.meetstream.ai/mcp`, leave the OAuth fields blank and click Connect, then sign in and click Allow. If OAuth is not an option, `https://mcp.meetstream.ai/mcp?key=YOUR_MEETSTREAM_API_KEY` works, since Claude's custom connectors cannot send a custom auth header; give each person their own key so it can be revoked individually.

### Cursor

Add to `~/.cursor/mcp.json`, or install the [MeetStream Cursor plugin](https://github.com/meetstream-ai/meetstream-cursor-plugin), then click Connect in Cursor Settings -> MCP:

```json
{
  "mcpServers": {
    "meetstream": { "url": "https://mcp.meetstream.ai/mcp" }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`; Cascade asks you to sign in on first use. If your Windsurf version cannot finish the sign-in, add `"headers": { "Authorization": "Bearer YOUR_MEETSTREAM_API_KEY" }`.

```json
{
  "mcpServers": {
    "meetstream": { "serverUrl": "https://mcp.meetstream.ai/mcp" }
  }
}
```

### Codex

Add to `~/.codex/config.toml`, then run `codex mcp login meetstream`. With a key instead, add `bearer_token_env_var = "MEETSTREAM_API_KEY"`.

```toml
[mcp_servers.meetstream]
url = "https://mcp.meetstream.ai/mcp"
```

### Clients that only speak the old HTTP+SSE transport

Use `https://mcp.meetstream.ai/sse` with the same sign-in or key options. Everything else uses `/mcp`, whose replies already stream as server-sent events.

### Use the MCP before

- calling any MeetStream endpoint
- changing webhook handling or event names
- adding or changing bot, transcription, calendar or MIA behaviour
- relying on any request field, response field, provider name or status code

## Working in this repo

There is no root package, no workspace and no shared build. Each template stands alone.

```sh
cd <template-name>
cp .env.example .env      # then fill in MEETSTREAM_API_KEY
npm install
node index.js
```

Node **>= 18**, ESM (`"type": "module"`), built-in `fetch`. No TypeScript, no bundler.

### Every template must have

```
<template-name>/
  README.md          what it does, prerequisites, setup, run, how it works, troubleshooting
  .env.example       every variable it reads, commented, placeholders only
  package.json       name "@meetstream-labs/<template-name>", type module, start script
  .gitignore         node_modules, .env, output dirs
  index.js           entry point, runnable with `node index.js`
  src/*.js           split logic out when it helps readability
```

### Rules for templates

- **Never invent an endpoint or a field.** Check it against the MCP first. Several templates have shipped bugs from guessed endpoints.
- Read config from `process.env` and **fail fast with a clear message** when `MEETSTREAM_API_KEY` is missing.
- `.env.example` carries placeholders only, never a real key.
- Handle errors honestly: check `res.ok`, surface the API's `message`, treat `507` as success, poll on `202` with a retry cap.
- Keep dependencies minimal - `express` for webhooks, `ws` for websockets, `dotenv`. Nothing exotic.
- No placeholder or TODO logic pretending to work.
- The README opens with a one-line description and the exact install-and-run commands.

### Before you commit a template

```sh
node --check index.js          # and every file under src/
```

Confirm the README, `.env.example` and `package.json` all exist and agree with the code, and add the template to the right section of the root `README.md`.

## API rules that are easy to get wrong

These are live-verified. Do not "fix" code that follows them.

- **Auth differs by surface.** The REST API at `api.meetstream.ai` uses `Authorization: Token <key>`. The MCP server at `mcp.meetstream.ai` uses `Authorization: Bearer <key>`. Mixing them up returns 401.
- Every webhook carries the event name under **`event`**, and most also carry **`bot_event`** with the specific name.
- **Terminals are two-layer.** Every ending arrives once with `event: "bot.stopped"`; `bot_event` says why (`bot.stopped`, `bot.kicked`, `bot.notallowed`, `bot.denied`, `bot.failed`). Lobby timeouts, denials and failures carry `status_code: 500`, clean exits and kicks `200`. Branch on `bot_event`: a kick and a clean exit both report `bot_status: "Stopped"`.
- Every event carries a `timestamp`.
- **Streaming-only providers produce no post-call transcript**: no `transcription.processed`, though `bot.done` still fires. A post-call transcript fetch for them returns `202` indefinitely, so any polling loop needs a cap.
- Over REST, transcripts are fetched by **`transcript_id`**, not `bot_id`. The MCP `get_transcript` tool is the exception: it takes `bot_id` and resolves the `transcript_id` itself. Either way, segments use **`transcript`**, not `text`.
- **`202` and `507` are not errors.** 202 means poll again; 507 means an idempotent retry replayed and is a success.
- The bot field is **`meeting_link`**, not `meeting_url`.
- `in_call_recording_timeout` has a hard floor of **600 seconds**; below it the API returns 400.
- MIA bots take **only `agent_config_id`**. Adding `socket_connection_url` or `live_audio_required` alongside it is the usual cause of a silent agent.
- **Video is off by default.** Send `"video_required": false` on every bot unless the user explicitly asks to record video. The API defaults it to `true`, so an omitted field records video, and transcripts, summaries, diarization and speaker timelines all work without it.
- **When video is on, send a layout.** `recording_config.video_layout` accepts exactly `"speaker_view"` or `"grid_view"` and defaults to `"grid_view"`, so pass `"speaker_view"` explicitly unless the user asks for grid or gallery view. It is ignored when video is off; Google Meet, Teams and Zoom accept both values, and WhatsApp accepts only `"grid_view"`.
- **Per-participant video is opt-in only.** Never set `video_separate_streams` (top level or under `recording_config`) unless the user explicitly asks for per-participant video streams. Per-participant audio (`audio_separate_streams`) is unaffected.

## Security

- Never hard-code or commit a key. `ms_...` values belong in the environment.
- Never log a key, a transcript, or participant data.
- Do not expose a server-side key to client code.
- Verify webhook signatures before acting on a payload.
- Do not persist meeting, transcript, participant or recording data unless asked.

## Before you finish

- Every touched template passes `node --check`.
- Every endpoint and field used is confirmed against the MCP.
- New templates are listed in the root `README.md`.
- State which MCP tools or docs you relied on, what changed, and what you did not verify.

## Related

- Docs: https://docs.meetstream.ai
- MCP server: https://github.com/meetstream-ai/meetstream-mcp (hosted at `https://mcp.meetstream.ai/mcp`)
- CLI: [`@meetstream/cli`](https://github.com/meetstream-ai/meetstream-cli)
- Claude Code plugin: https://github.com/meetstream-ai/claude-plugin
- Cursor plugin: https://github.com/meetstream-ai/meetstream-cursor-plugin
- Runnable examples: https://github.com/meetstream-ai/labs
