---
name: speak-in-meeting
description: >
  Make a MeetStream bot speak out loud in a live meeting using a MIA voice
  agent. Use when the user says "introduce yourself in the meeting", "say
  something in the call", "talk to them", "speak", "voice", "join and greet
  everyone", "answer questions out loud", "MIA", "voice agent", or wants the bot
  to be heard rather than only post in chat. Explains which speech the MCP tools
  can and cannot produce.
---

# Speak in a live meeting

## What is possible

The MeetStream MCP server has **no "speak this text" tool**. Bot speech comes
from a **MIA voice agent**, which MeetStream hosts. Attach one with a single
field on `create_bot`:

```json
{ "meeting_link": "https://...", "bot_name": "Hermes", "agent_config_id": "<id>" }
```

When it joins, the agent speaks its configured `first_message` (for example an
introduction). After that it holds a spoken conversation using **its own**
model and system prompt, configured in MeetStream rather than in Hermes.

| The user wants | Do this |
|---|---|
| The bot to join and introduce itself out loud | `create_bot` with the user's `agent_config_id`. Its `first_message` is the intro. |
| The bot to answer people out loud during the call | Same - MIA listens and replies on its own. |
| Hermes to say a specific new sentence right now | Not possible over MCP. Post it with `send_chat_message` and say it went to chat. |
| Hermes itself to be the voice in the room | Point the user to the MIA x Hermes bridge (link below). That is a separate, self-hosted service. |

Never claim the bot said something out loud unless a MIA agent was attached
and the bot reached `InMeeting`/`Recording`.

## Getting an `agent_config_id`

MIA agents are created over the REST API or in the dashboard, not with an MCP
tool. Use the id the user gives you. If they have none, tell them to run this
once in their own terminal (the README has a ready-made config):

```sh
npx -y @meetstream/cli mia create -f examples/mia-intro-agent.json
```

Then ask them for the `agent_config_id` it prints. Do not try to create MIA
agents yourself with terminal HTTP calls; that would expose the user's API key
in commands and logs.

## Rules that prevent a silent bot

- Pass **only** `agent_config_id`. Never add `socket_connection_url` or
  `live_audio_required` - these are for self-hosted bridges and are the most
  common cause of an agent that joins but never speaks.
- Speech starts only after the bot is admitted. Follow `get_bot_status` until
  `InMeeting` or `Recording` before telling the user it has spoken.
- If the agent joins but stays silent: check that a wake word is not enabled on
  the agent, and that its model/voice provider is configured on the user's
  MeetStream account. A `first_message` is the most reliable first speech.

## Reference

- [Create a MIA agent](https://docs.meetstream.ai/guides/mia/create-an-agent)
- [MIA configurations](https://docs.meetstream.ai/guides/mia/mia-custom-configurations)
- [MeetStream CLI `mia create`](https://github.com/meetstream-ai/meetstream-cli)
- [MIA x Hermes bridge (Hermes as the in-meeting voice)](https://github.com/meetstream-ai/labs/tree/main/mia-hermes-bridge)
