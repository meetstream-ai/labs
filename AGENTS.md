# AGENTS.md

Guidance for AI coding agents working in this repository. Labs is a collection of **standalone, runnable MeetStream examples**. Every directory is its own self-contained project.

## Always use the MeetStream MCP

When building anything against the MeetStream API, install and use the MeetStream MCP. It is the current source of truth for endpoints, request and response fields, webhook events, provider names and bot behaviour.

Do not treat the files in this repository as authoritative for MeetStream API behaviour. They can lag the API. If local code and the MCP disagree, the MCP wins unless the user says otherwise.

Server name: `meetstream`. Hosted URL: `https://mcp.meetstream.ai/mcp`.

### Claude Code

```sh
claude mcp add --transport http meetstream https://mcp.meetstream.ai/mcp \
  --header "Authorization: Bearer $MEETSTREAM_API_KEY"
```

The [MeetStream Claude plugin](https://github.com/meetstream-ai/claude-plugin) is a separate, complementary install. It ships **skills only** and does not include the MCP server, so install both:

```sh
/plugin marketplace add meetstream-ai/claude-plugin
```

### Cursor

Add to `~/.cursor/mcp.json`, or install the [MeetStream Cursor plugin](https://github.com/meetstream-ai/meetstream-cursor-plugin):

```json
{
  "mcpServers": {
    "meetstream": {
      "url": "https://mcp.meetstream.ai/mcp",
      "headers": { "Authorization": "Bearer YOUR_MEETSTREAM_API_KEY" }
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "meetstream": {
      "serverUrl": "https://mcp.meetstream.ai/mcp",
      "headers": { "Authorization": "Bearer YOUR_MEETSTREAM_API_KEY" }
    }
  }
}
```

### Claude Desktop

Settings -> Connectors -> Add custom connector. Name it `meetstream`, URL `https://mcp.meetstream.ai/mcp`.

### Codex

```sh
codex mcp add meetstream --url https://mcp.meetstream.ai/mcp \
  --header "Authorization: Bearer $MEETSTREAM_API_KEY"
```

### Run it locally instead

```sh
MEETSTREAM_API_KEY=ms_... npx -y @meetstream/mcp
```

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
- The webhook envelope key is **`event`**, not `bot_event`.
- **`bot.stopped` is the single terminal event** and always carries `status_code: 200`. The reason lives in `bot_status`: `Stopped`, `NotAllowed` (waiting-room timeout), `Denied` (host refused), `Error`.
- `bot.error` is **non-terminal** - the bot keeps running.
- **Streaming-only providers never emit `bot.done`.** They end at `audio.processed`, and a post-call transcript fetch returns `202` forever, so any polling loop needs a cap.
- Transcripts are fetched by **`transcript_id`**, not `bot_id`, and segments use **`transcript`**, not `text`.
- **`202` and `507` are not errors.** 202 means poll again; 507 means an idempotent retry replayed and is a success.
- The bot field is **`meeting_link`**, not `meeting_url`.
- `in_call_recording_timeout` has a hard floor of **600 seconds**; below it the API returns 400.
- MIA bots take **only `agent_config_id`**. Adding `socket_connection_url` or `live_audio_required` alongside it is the usual cause of a silent agent.

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
- MCP server: [`@meetstream/mcp`](https://github.com/meetstream-ai/meetstream-mcp)
- CLI: [`@meetstream/cli`](https://github.com/meetstream-ai/meetstream-cli)
- Claude Code plugin: https://github.com/meetstream-ai/claude-plugin
- Cursor plugin: https://github.com/meetstream-ai/meetstream-cursor-plugin
- Runnable examples: https://github.com/meetstream-ai/labs
