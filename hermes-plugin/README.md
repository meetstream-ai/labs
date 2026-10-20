<div align="center">

# MeetStream for Hermes

**Let your Hermes agent join, talk in, and summarize live meetings.**

Your [Hermes Agent](https://github.com/NousResearch/hermes-agent) sends a MeetStream bot into **Zoom**, **Google Meet** or **Microsoft Teams**, chats in the call, speaks through a [MIA voice agent](#speaking-in-the-meeting), and pulls summaries and transcripts afterwards. It does this with **19 tools** and **6 skills** over the hosted [MeetStream](https://meetstream.ai) MCP server.

[![Docs](https://img.shields.io/badge/docs-docs.meetstream.ai-fd6316?style=flat-square)](https://docs.meetstream.ai)
[![MCP](https://img.shields.io/badge/MCP-19%20tools-6b4ea8?style=flat-square)](https://docs.meetstream.ai/build-with-ai/meetstream-mcp-server)
[![Skills](https://img.shields.io/badge/skills-6-45689f?style=flat-square)](#skills)
[![License](https://img.shields.io/badge/license-MIT-867c72?style=flat-square)](LICENSE)

[Install](#install) · [Try it](#what-you-can-ask) · [Demo](#real-meeting-demo) · [Architecture](#architecture) · [Security](#your-api-key) · [Troubleshooting](#troubleshooting)

</div>

---

You run nothing extra. No server, no bridge, no audio pipeline. The plugin is a declarative [Agent Plugins v1](https://agent-plugins.org/specification) package that Hermes loads natively. It contains one MCP connection to `https://mcp.meetstream.ai/mcp`, six skills, and your own API key read from Hermes' environment.

## Install

> **New to this?** [INSTALL.md](INSTALL.md) is the full step-by-step guide. It covers the terminal and the desktop app, setting up a voice, your first real meeting, and troubleshooting, with a check after every step.

**Prerequisites:** [Hermes Agent](https://github.com/NousResearch/hermes-agent) (terminal or desktop app) with a model configured (`hermes model`), and a MeetStream API key from [app.meetstream.ai/api-keys](https://app.meetstream.ai/api-keys).

```bash
# 1. Install and enable the plugin
hermes plugins install meetstream-ai/hermes-plugin --enable
#    desktop alternative: open hermes://plugin/install?repo=meetstream-ai/hermes-plugin&enable=1

# 2. Give Hermes your MeetStream key (saved to ~/.hermes/.env, never to config.yaml)
hermes config set MEETSTREAM_API_KEY ms_your_key_here

# 3. Start a NEW session so the MCP tools and skills load
hermes                     # terminal; in the desktop app: quit, reopen, click New chat
```

Then ask: *"List my MeetStream bots."* A clean answer means the key, the plugin and the MCP connection are all working.

> [!IMPORTANT]
> **Start a new chat after installing or setting the key.** Hermes loads MCP tools only when a session starts. An already-open chat answers *"I don't have a MeetStream tool"* even when everything is configured correctly.

> [!NOTE]
> - Hermes installs this type of plugin **disabled**. If you installed without `--enable`, run `hermes plugins enable meetstream`.
> - In the desktop app the plugin is listed under **Capabilities → Plugins → Installed**.
> - The app has no screen for the MeetStream key; **Settings → Providers** is for model keys only. Set it with `hermes config set` as shown above. The app and the terminal share the same settings.

## What you can ask

Plain language. Hermes picks the tools, and the skills tell it how to use them well.

> "Join my meeting at https://meet.google.com/abc-defg-hij and introduce yourself."

> "Is the bot in yet? Post 'Recording started - say stop if you'd rather not' in the chat."

> "Who's in the call right now, and what have people said in chat?"

> "Summarize that meeting. Give me decisions and action items with owners."

> "Send a bot to my 3pm on my calendar."

> "Make the bot leave."

## Speaking in the meeting

The MeetStream MCP server has **no "say this sentence" tool**. Speech comes from a **MIA voice agent**, which MeetStream hosts, and you attach one with a single `agent_config_id` on `create_bot`. When the bot is admitted, the agent speaks its configured `first_message`, such as an introduction. After that it talks with participants using its own model and prompt.

| You want | How |
|---|---|
| The bot to join and introduce itself out loud | Attach a MIA agent: *"Join … with agent_config_id `<id>` and introduce yourself."* |
| The bot to answer people out loud | The same MIA agent listens and replies on its own. |
| Hermes to post an arbitrary message right now | `send_chat_message`. Chat is where Hermes speaks in real time. |
| **Hermes itself** to be the voice in the room | Use the [MIA × Hermes bridge](https://github.com/meetstream-ai/labs/tree/main/mia-hermes-bridge). See [Relationship to the MIA × Hermes bridge](#relationship-to-the-mia--hermes-bridge). |

Create a voice agent once with the official CLI and the ready-made config in this repo:

```bash
export MEETSTREAM_API_KEY=ms_your_key_here        # the CLI reads the key from your shell
npx -y @meetstream/cli mia create -f examples/mia-intro-agent.json
# -> prints JSON containing "agent_config_id": "..."
```

> [!IMPORTANT]
> Attach the agent with **only** `agent_config_id`. Ignore the CLI's follow-up hint about `--socket-ws` / `--live-audio-ws`. Those flags are for self-hosted bridges, and adding them to a hosted MIA bot is the most common cause of an agent that joins but never speaks. The `speak-in-meeting` skill enforces this.

`examples/mia-intro-agent.json` uses the provider set already verified live against MeetStream: `pipeline` mode, OpenAI `gpt-4o` with `tts-1`/`alloy`, Deepgram `nova-3`, 48 kHz mono. Edit `first_message` to change what the bot says on arrival. Model and voice providers must be enabled on your MeetStream account.

## Real-meeting demo

The full chain is **Hermes agent → MeetStream MCP → MeetStream bot → real meeting → bot speaks**.

```bash
git clone https://github.com/meetstream-ai/hermes-plugin.git && cd hermes-plugin
hermes plugins install meetstream-ai/hermes-plugin --enable
hermes config set MEETSTREAM_API_KEY ms_your_key_here
export MEETSTREAM_API_KEY=ms_your_key_here          # only needed to auto-create the voice agent

# Start a Google Meet (or Zoom/Teams) call yourself, then:
scripts/demo.sh 'https://meet.google.com/abc-defg-hij'
```

[`scripts/demo.sh`](scripts/demo.sh) does the following:

1. Checks that Hermes is installed, the plugin is enabled and `MEETSTREAM_API_KEY` is configured.
2. Creates the MIA voice agent from `examples/mia-intro-agent.json` via `@meetstream/cli`. Skip this by passing an id as the second argument or setting `MEETSTREAM_MIA_AGENT_ID`.
3. Runs one Hermes turn (`hermes -z`) with the `join-meeting`, `speak-in-meeting` and `meeting-chat` skills preloaded. Hermes calls `create_bot` with the voice agent attached, polls `get_bot_status` until the bot is admitted, then calls `send_chat_message`.

Verified end to end on 2026-10-06 against a live Google Meet call: the bot was dispatched, admitted, reached `InMeeting`, and posted its chat greeting.

**Your part:** when a participant named **Hermes** appears in the waiting room, admit it (you have about 5 minutes). You should then **hear** the introduction and see a hello in chat. Clean up with `hermes -z "Remove my MeetStream bot from the meeting at <url>"`.

You can also run the demo by hand in an interactive `hermes` session:

> Join my meeting at https://meet.google.com/abc-defg-hij using MeetStream agent_config_id `<id>` and introduce yourself. Once you're admitted, say hi in the chat too.

## Architecture

```text
 You ──prompt──▶ Hermes agent (model, tool choice, conversation state)
                    │  mcp__meetstream__create_bot / send_chat_message / get_transcript …
                    │  Streamable HTTP, Authorization: Bearer <your key, read at connect time>
                    ▼
            mcp.meetstream.ai/mcp  (hosted, multi-tenant, stores no keys)
                    │  MeetStream REST API
                    ▼
            MeetStream bot + MIA ──joins, records, chats, speaks──▶ Zoom / Meet / Teams
```

| Layer | Owns |
|---|---|
| **Hermes** | Model, deciding when to call tools, conversation and memory. |
| **This plugin** | One MCP connection declaration and six skills. No executable code runs inside Hermes. |
| **MeetStream MCP** | The 19-tool API surface, auth to MeetStream REST, transcript resolution. |
| **MeetStream** | Joining meetings, transport, audio in and out, chat, recording, bot lifecycle, MIA voice. |

### Package layout

```text
INSTALL.md                   Step-by-step install and first-meeting guide
plugin.json                  Agent Plugins v1 manifest (name: meetstream)
mcp.json                     One streamable-http server -> https://mcp.meetstream.ai/mcp
skills/<name>/SKILL.md       6 skills, loaded via skills_list / skill_view
examples/mia-intro-agent.json  MIA voice agent config for the demo
scripts/demo.sh              End-to-end real-meeting demo
scripts/check.py             Repository checks (manifests, skills, tool names, secrets)
```

Hermes discovers `plugin.json` and loads it through its Agent Plugins v1 adapter. That adapter is Hermes' only native mechanism for a standalone plugin repo to ship an MCP server, which is why this repo does not use `plugin.yaml` with Python. The server keeps its `mcp.json` name, so tools appear as `mcp__meetstream__<tool>`. Skills are namespaced as `agent-plugin-meetstream-ee716565:<skill>`.

### The 19 tools

These come from the hosted server, not from this repo, so they stay current automatically.

| Area | Tools |
|---|---|
| Bot lifecycle | `create_bot` · `list_bots` · `get_bot_status` · `get_bot_detail` · `get_bot_summary` · `remove_bot` · `delete_bot_data` |
| Transcription | `get_transcript` · `list_transcriptions` · `transcribe_audio` |
| Meeting data | `get_media_urls` · `get_participants` · `get_chats` · `get_speaker_timeline` |
| Live interaction | `send_chat_message` · `send_image` |
| Calendar | `list_calendar_events` · `schedule_calendar_bot` |
| Reference | `webhook_events_guide` |

Full reference: [MeetStream MCP server](https://github.com/meetstream-ai/meetstream-mcp#full-capability-list---19-tools).

### Skills

| Skill | Loads when you say |
|---|---|
| [join-meeting](skills/join-meeting/SKILL.md) | "join my meeting", "send a bot to…", "is the bot in yet", "make it leave" |
| [speak-in-meeting](skills/speak-in-meeting/SKILL.md) | "introduce yourself", "say something in the call", "voice agent", "MIA" |
| [meeting-chat](skills/meeting-chat/SKILL.md) | "post in the chat", "who's in the call", "what are people saying" |
| [meeting-brief](skills/meeting-brief/SKILL.md) | "summarize that meeting", "action items", "pull the transcript" |
| [calendar-bots](skills/calendar-bots/SKILL.md) | "what meetings do I have", "send a bot to my 3pm" |
| [troubleshooting](skills/troubleshooting/SKILL.md) | "401", "the bot never joined", "the bot is silent" |

The skills are adapted from the [MeetStream Cursor plugin](https://github.com/meetstream-ai/meetstream-cursor-plugin) and trimmed to what the MCP tools actually support. REST-only features are named as REST-only, never presented as tools. That includes creating MIA agents, connecting calendars and signed-in bot accounts.

### Relationship to the MIA × Hermes bridge

[`labs/mia-hermes-bridge`](https://github.com/meetstream-ai/labs/tree/main/mia-hermes-bridge) solves the **opposite direction**, and the two are complementary:

| | This plugin | MIA × Hermes bridge |
|---|---|---|
| Direction | You → Hermes → meeting | Meeting participants → Hermes → meeting |
| Who drives | Hermes acts on **your** instructions | Hermes answers **people in the call** |
| What runs | Nothing. Declarative package | Self-hosted Node service, public HTTPS/WSS ingress, Hermes API server |
| Voice | MIA agent with its own model | Hermes' answers, via TTS and `sendaudio` |
| Transport | Hosted MCP + MeetStream | MeetStream WebSockets terminated by the bridge |

Use this plugin to send, control and debrief bots from your Hermes agent. Use the bridge when Hermes itself should be the participant who talks. Neither reimplements the other, and neither reimplements MeetStream transport.

## Your API key

- **Yours, per user.** Hermes interpolates `${MEETSTREAM_API_KEY}` into the `Authorization` header **at connect time**, from your environment or `~/.hermes/.env`. It is sent with each request to the hosted MCP server.
- **Never stored server-side.** `mcp.meetstream.ai` is multi-tenant and stateless. It builds a fresh client per request from the header and keeps no key database ([source](https://github.com/meetstream-ai/meetstream-mcp/blob/main/src/http-server.js)).
- **Never in this repo.** `mcp.json` contains only the `${MEETSTREAM_API_KEY}` placeholder. `scripts/check.py` scans every file for key-shaped strings.
- **Fails closed.** If the variable is unset, Hermes refuses to connect and names the missing variable. It never sends a literal `${…}` header.
- **Revocable.** Each person should use their own key so it can be revoked individually at [app.meetstream.ai/api-keys](https://app.meetstream.ai/api-keys).
- **Profiles.** Under a multi-profile Hermes gateway, each profile resolves the key from its own `.env`.

Prefer the key never leaving your machine? Skip the plugin's hosted connection and run the same server locally over stdio in `~/.hermes/config.yaml`. A `config.yaml` server named `meetstream` takes precedence over the plugin's:

```yaml
mcp_servers:
  meetstream:
    command: npx
    args: ["-y", "@meetstream/mcp"]
    env:
      MEETSTREAM_API_KEY: "${MEETSTREAM_API_KEY}"
```

<details>
<summary><b>Config-only setup without the plugin</b> (tools but no skills)</summary>

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  meetstream:
    url: "https://mcp.meetstream.ai/mcp"
    headers:
      Authorization: "Bearer ${MEETSTREAM_API_KEY}"
```

</details>

## Verify the installation

```bash
hermes plugins show meetstream            # Status: enabled
hermes config env-path                    # the .env that should contain MEETSTREAM_API_KEY
hermes -z "Call the MeetStream list_bots tool and tell me how many bots I have."
```

Inside a session, ask *"Which MeetStream tools and skills do you have?"* Hermes should list the `mcp__meetstream__*` tools and find the `agent-plugin-meetstream-…` skills through `skills_list`.

## Troubleshooting

First look at what Hermes logged: `grep -h meetstream ~/.hermes/logs/*.log | tail -5`. The full table is in [INSTALL.md](INSTALL.md#troubleshooting).

| Symptom | Fix |
|---|---|
| Hermes says it has no MeetStream tool or "can't join Google Meet" | Key not set, or the chat started before setup. Set the key, then open a **new** chat. |
| No `mcp__meetstream__*` tools | `hermes plugins enable meetstream`, then start a **new** session. |
| Log: `registered 0 tool(s) … 1 failed: meetstream` | The connection failed; the reason follows in the same log line, usually the missing key. |
| `${MEETSTREAM_API_KEY} in url/headers is not set` | `hermes config set MEETSTREAM_API_KEY ms_…`, then start a new session. |
| `401 Missing MeetStream API key` | The header never arrived. Check for a stray space or newline in the key (Hermes logs a whitespace warning). |
| `403` | The key is wrong, revoked or truncated. Create a new one. |
| `Portable MCP server 'meetstream' conflicts with native config` | You also have `mcp_servers.meetstream` in `config.yaml`. That entry wins. Remove it to use the plugin's. |
| The bot sits in the waiting room | A host must admit it. `NotAllowed` means nobody did before the timeout. |
| The bot joins but never speaks | No `agent_config_id`, a wake word enabled on the agent, or bridge fields added. See [Speaking](#speaking-in-the-meeting). |
| The transcript never arrives | A streaming provider was used, so there is no post-call transcript. Ask Hermes to run `transcribe_audio`. |

More: [MeetStream errors](https://docs.meetstream.ai/errors) · [Debugging bots](https://docs.meetstream.ai/guides/help/debugging-bots) · [Hermes MCP docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp).

## Development

```bash
git clone https://github.com/meetstream-ai/hermes-plugin.git && cd hermes-plugin

python3 scripts/check.py           # manifests, skills, links, secret scan, no-transport guard, hermes validate/doctor
python3 scripts/check.py --live    # + cross-check every tool the skills mention against the real server (Node 18+, no key needed)

hermes plugins validate .          # Hermes' own catalog gate
hermes plugins doctor --ci .       # Hermes' runtime contract check
```

To test local edits in Hermes, push them to a branch (or any git URL) and reinstall:

```bash
hermes plugins install https://github.com/<you>/hermes-plugin.git --force --enable
```

Rules for contributors are in [AGENTS.md](AGENTS.md). The short version: no code that talks to meetings, no keys in files, every skill `name` matches its directory, and never describe a tool the MCP server does not expose.

## The rest of the ecosystem

| | Where |
|---|---|
| MCP server (the 19 tools) | [`meetstream-ai/meetstream-mcp`](https://github.com/meetstream-ai/meetstream-mcp) · [`@meetstream/mcp`](https://www.npmjs.com/package/@meetstream/mcp) |
| CLI | [`meetstream-ai/meetstream-cli`](https://github.com/meetstream-ai/meetstream-cli) |
| Cursor plugin | [`meetstream-ai/meetstream-cursor-plugin`](https://github.com/meetstream-ai/meetstream-cursor-plugin) |
| Claude Code plugin | [`meetstream-ai/claude-plugin`](https://github.com/meetstream-ai/claude-plugin) |
| MIA × Hermes bridge | [`meetstream-ai/labs/mia-hermes-bridge`](https://github.com/meetstream-ai/labs/tree/main/mia-hermes-bridge) |
| Docs | [docs.meetstream.ai](https://docs.meetstream.ai) |

<div align="center">

---

Built by [MeetStream.ai](https://meetstream.ai) · [MIT](LICENSE)

</div>
