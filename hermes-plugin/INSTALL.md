# Installing MeetStream in Hermes

A step-by-step guide to getting the MeetStream plugin working in [Hermes Agent](https://github.com/NousResearch/hermes-agent), from a fresh install to a bot speaking in a live meeting. Each step ends with a check, so you know it worked before you move on.

**Time:** about 10 minutes. **You need:** a Mac, Linux or Windows machine with Hermes installed and a model configured, a MeetStream account, and a Google Meet, Zoom or Teams call you can join.

| Step | What you do | Result |
|---|---|---|
| [1](#step-1-check-hermes-is-ready) | Check Hermes is ready | Hermes runs and has a model |
| [2](#step-2-get-a-meetstream-api-key) | Get a MeetStream API key | A key starting with `ms_` |
| [3](#step-3-install-the-plugin) | Install the plugin | `meetstream` installed and enabled |
| [4](#step-4-save-your-api-key-in-hermes) | Save your key in Hermes | Key in `~/.hermes/.env` |
| [5](#step-5-start-a-new-session) | Start a **new** session | Tools and skills load |
| [6](#step-6-verify) | Verify | Hermes lists your bots |
| [7](#step-7-set-up-a-voice-optional) | Set up a voice (optional) | An `agent_config_id` |
| [8](#step-8-join-a-real-meeting) | Join a real meeting | A bot in your call |

---

## Step 1. Check Hermes is ready

In a terminal:

```bash
hermes --version
```

You should see something like `Hermes Agent v0.21.x`. If the command isn't found, install Hermes from [github.com/NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) first.

Hermes also needs an AI model. If you've never chosen one:

```bash
hermes model
```

✅ **Check:** `hermes -z "say hello"` prints a reply. If it says Hermes "is not connected to any AI provider", run `hermes model` again.

> The **Hermes desktop app** (`Hermes.app`) and the `hermes` terminal command share the same settings, plugins and keys. Anything you set up in one works in the other. Some steps below use the terminal because the app has no screen for them.

## Step 2. Get a MeetStream API key

1. Sign in at [app.meetstream.ai](https://app.meetstream.ai).
2. Open [app.meetstream.ai/api-keys](https://app.meetstream.ai/api-keys) and create a key.
3. Copy it. It starts with `ms_`.

Treat the key like a password. Don't paste it into a chat with Hermes or any other AI. Saving it into Hermes' settings file (Step 4) is the right place for it.

✅ **Check:** you have a key that starts with `ms_`.

## Step 3. Install the plugin

Choose **one** of these options.

### Option A: terminal (recommended)

```bash
hermes plugins install meetstream-ai/hermes-plugin --enable
```

Hermes downloads the plugin, runs its security scan, and enables it. You'll see `✓ Installed` and `Plugin meetstream enabled`. A "custom (unreviewed) source" warning is normal for plugins that aren't in the Hermes catalog yet.

### Option B: desktop app

Open this link on the computer where the Hermes app is installed:

```
hermes://plugin/install?repo=meetstream-ai/hermes-plugin&enable=1
```

The app shows an install dialog. Review it and confirm.

### Option C: from a local copy

Use this for development, or before the GitHub repo is public:

```bash
git clone https://github.com/meetstream-ai/hermes-plugin.git
cd hermes-plugin
hermes plugins install "file://$PWD" --enable
```

Hermes installs from git, so it uses the latest **committed** version. Commit your changes, then reinstall with `--force` to pick them up.

### If you installed without `--enable`

Plugins of this type install **disabled** for safety. Turn it on with:

```bash
hermes plugins enable meetstream
```

✅ **Check:**

```bash
hermes plugins show meetstream
```

You should see `Status: enabled`. In the **desktop app**, the plugin appears under **Capabilities → Plugins → Installed** as **meetstream**.

## Step 4. Save your API key in Hermes

```bash
hermes config set MEETSTREAM_API_KEY ms_your_key_here
```

Hermes saves any `UPPER_CASE` setting to its private secrets file, `~/.hermes/.env`, not to the main `config.yaml`. The plugin reads it from there each time it connects to MeetStream. The key isn't stored in the plugin or on any MeetStream server.

There's no screen for this in the desktop app. **Settings → Providers** is only for AI model keys, so use the terminal command above.

✅ **Check** (prints a count, never the key):

```bash
grep -c '^MEETSTREAM_API_KEY=.' "$(hermes config env-path)"
```

`1` means the key is saved. `0` means it isn't, so run the `config set` command again.

> **Using Hermes profiles?** Each profile has its own `.env`. Run `hermes config set` while that profile is active, and `hermes config env-path` shows which file you're editing.

## Step 5. Start a new session

**This step is required.** Hermes connects to MeetStream and loads tools only when a session **starts**, so a chat that was already open won't get the MeetStream tools.

- **Desktop app:** quit Hermes completely (⌘Q on a Mac), reopen it, and click **New chat**. Don't continue an old conversation.
- **Terminal:** exit any running `hermes` session and start a new one with `hermes`.
- **Gateway** (Telegram, Slack, etc.): `hermes gateway restart`.

## Step 6. Verify

In a **new** chat, ask:

> List my MeetStream bots.

✅ **It works if** Hermes answers with your bots, or says you have none. Behind the scenes it called the `mcp__meetstream__list_bots` tool.

❌ **It's broken if** Hermes says something like *"I don't have a meetstream tool"* or *"I can't join Google Meet calls"*. Go to [Troubleshooting](#troubleshooting).

You can also ask *"Which MeetStream tools and skills do you have?"*. Expect **19 tools** (`create_bot`, `send_chat_message`, `get_transcript`, …) and **6 skills** (`join-meeting`, `speak-in-meeting`, `meeting-chat`, `meeting-brief`, `calendar-bots`, `troubleshooting`).

The same check from the terminal:

```bash
hermes -z "Call the MeetStream list_bots tool and tell me how many bots I have."
```

## Step 7. Set up a voice (optional)

Without this step the bot can join, record, read and post chat, and summarize, but it **can't talk**. Speech comes from a **MIA voice agent**, which MeetStream runs for you. You create one once and reuse it.

### Option A: use the ready-made agent in this repo

```bash
cd hermes-plugin                                  # your clone of this repo
export MEETSTREAM_API_KEY=ms_your_key_here        # the CLI reads it from your shell
npx -y @meetstream/cli mia create -f examples/mia-intro-agent.json
```

Requires [Node.js 18+](https://nodejs.org). The output is JSON. Copy the `agent_config_id` value.

> Ignore the CLI's hint about `--socket-ws` / `--live-audio-ws`. Those flags are for self-hosted setups and will make a MeetStream-hosted voice agent silent.

To change what the bot says when it joins, edit `first_message` in `examples/mia-intro-agent.json` before you create the agent.

### Option B: reuse an agent you already have

```bash
npx -y @meetstream/cli mia list
```

Use an `AgentConfigID` from the list. You can also create and manage agents in the MeetStream dashboard.

### Make sure your account can speak

The example agent uses OpenAI for the model and voice, and Deepgram for listening. Those providers must be enabled on your MeetStream account. If the bot joins but stays silent, this is the first thing to check.

✅ **Check:** you have an `agent_config_id` (a UUID such as `4c557f0a-8282-4f34-865a-787902ba52be`).

## Step 8. Join a real meeting

1. Start a Google Meet, Zoom or Teams call and join it yourself.
2. In a **new** Hermes chat, ask:

   > Join my meeting at https://meet.google.com/abc-defg-hij using MeetStream agent_config_id `<your id>` and introduce yourself. Once you're admitted, say hi in the chat too.

   For a chat-only bot, leave out the `agent_config_id` part.

3. A participant named after the bot (Hermes picks a name such as "Hermes") appears in the **waiting room**. **Admit it.** Google Meet always requires this, and many Zoom and Teams rooms do too.
4. You should **hear** the voice agent's introduction and **see** a hello in the chat.

What happens behind the scenes:

```
Hermes  → create_bot (meeting_link, bot_name, agent_config_id)
        → get_bot_status … InWaitingRoom … InMeeting
        → send_chat_message
MeetStream bot joins → the MIA agent speaks its first_message
```

### Things to ask while the bot is in the call

> Who's in the meeting right now?

> What has been said in the chat?

> Post "We're 5 minutes over, wrapping up" in the chat.

> Make the bot leave.

### After the meeting

> Summarize that meeting with decisions and action items.

> Get me the full transcript.

> Who talked the most?

### Or run the scripted demo

From a clone of this repo:

```bash
scripts/demo.sh 'https://meet.google.com/abc-defg-hij' <agent_config_id>
```

The script checks your setup and runs the whole flow in one Hermes turn. It waits up to about 5 minutes for you to admit the bot. If you leave out the `agent_config_id`, it creates one from `examples/mia-intro-agent.json` (this needs `MEETSTREAM_API_KEY` exported in your shell).

---

## Troubleshooting

Start by checking what Hermes logged about MeetStream:

```bash
grep -h meetstream ~/.hermes/logs/*.log | tail -5
```

| What you see | Cause | Fix |
|---|---|---|
| Hermes says it has no MeetStream tool, or "can't join Google Meet" | Tools didn't load: the key is missing, or the chat is old | Do Step 4, then Step 5 (new chat). |
| Log: `${MEETSTREAM_API_KEY} in url/headers is not set` | Key not saved (in this profile) | `hermes config set MEETSTREAM_API_KEY ms_…`, then start a new chat. |
| Log: `registered 0 tool(s) … 1 failed: meetstream` | Same as above, or no network | Fix the key, check your internet connection, start a new chat. |
| `hermes plugins show meetstream` says not installed or disabled | Step 3 not finished | `hermes plugins install … --enable` or `hermes plugins enable meetstream`. |
| Log: `Portable MCP server 'meetstream' conflicts with native config` | You also added `mcp_servers.meetstream` to `config.yaml` | Remove that entry; the `config.yaml` one wins otherwise. |
| `401 Missing MeetStream API key` | The key never reached MeetStream | Re-set the key; make sure no space or newline was pasted with it. |
| `403` | Key is wrong, revoked or truncated | Create a new key and set it again. |
| The bot sits in the waiting room | Nobody admitted it | Admit it in the meeting. `NotAllowed` means the wait timed out. Ask Hermes to send a new one. |
| `Denied` | A host rejected the bot | Ask the host to admit it, then send a new bot. |
| The bot joins but is silent | No voice agent, or providers not enabled | Include an `agent_config_id` (Step 7). Check OpenAI and Deepgram on your MeetStream account. Make sure the agent has no wake word enabled. |
| Hermes posted in chat but didn't "say" the sentence | Expected behaviour | Hermes can't speak arbitrary text. Speech comes from the voice agent's own model. See [Speaking](README.md#speaking-in-the-meeting). |
| No transcript after the meeting | Still processing, or a streaming provider was used | Wait a few minutes. For streaming providers, ask Hermes to run `transcribe_audio`. |
| Two bots in the meeting | Two requests sent bots | Ask Hermes to remove the extra one by its `bot_id`. |

## Managing the plugin

```bash
hermes plugins show meetstream              # status and version
hermes plugins update meetstream            # pull the latest version
hermes plugins disable meetstream           # turn off, keep installed
hermes plugins enable meetstream            # turn back on
hermes plugins remove meetstream            # uninstall
```

After any of these, start a new session.

### Changing or revoking your key

```bash
hermes config set MEETSTREAM_API_KEY ms_new_key   # replace
hermes config unset MEETSTREAM_API_KEY            # remove
```

If you revoke a key at [app.meetstream.ai/api-keys](https://app.meetstream.ai/api-keys), also remove or replace it in Hermes, then start a new session.

## Advanced

### Keep the key on your machine only

By default your key goes, with each request, to MeetStream's hosted MCP server, which doesn't store it. To make MeetStream calls straight from your own machine instead, add this to `~/.hermes/config.yaml`. It takes priority over the plugin's connection, and the plugin's skills still load:

```yaml
mcp_servers:
  meetstream:
    command: npx
    args: ["-y", "@meetstream/mcp"]
    env:
      MEETSTREAM_API_KEY: "${MEETSTREAM_API_KEY}"
```

### Tools only, no plugin

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  meetstream:
    url: "https://mcp.meetstream.ai/mcp"
    headers:
      Authorization: "Bearer ${MEETSTREAM_API_KEY}"
```

You get the 19 tools but none of the skills. The plugin is the recommended setup.

### Hermes as the voice in the room

This plugin lets **you** direct a bot through Hermes. If you want **people in the meeting** to talk to Hermes, with Hermes answering out loud, use the [MIA × Hermes bridge](https://github.com/meetstream-ai/labs/tree/main/mia-hermes-bridge). That's a separate service you host yourself.

## Getting help

- MeetStream docs: [docs.meetstream.ai](https://docs.meetstream.ai) · [Errors](https://docs.meetstream.ai/errors) · [Debugging bots](https://docs.meetstream.ai/guides/help/debugging-bots)
- Hermes docs: [Plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins) · [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)
- Support: [support@meetstream.ai](mailto:support@meetstream.ai)
