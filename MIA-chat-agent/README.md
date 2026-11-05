# Deploy a MIA Chat Agent into Meetings with the MeetStream API

Deploy a MeetStream Infrastructure Agent (MIA) as a meeting bot into Google Meet, Zoom or Microsoft Teams with the MeetStream API. The hosted agent listens for a wake word, answers questions and summarizes the meeting in the meeting chat. This Node.js program only creates the bot, receives lifecycle webhooks and removes the bot when you stop it.

MeetStream hosts the agent runtime. The Agent saved in the dashboard controls the model and the chat responses; there is no local speech-to-text, activation detector, LLM or chat bridge in this project.

## How it works

1. Reads `MEETSTREAM_API_KEY`, `MEETSTREAM_AGENT_CONFIG_ID` and `MEETING_LINK` from `.env` and fails fast if any is missing.
2. Fetches the saved Hosted Agent (`GET /mia`) and checks it is Pipeline or Realtime mode with a Chat response type.
3. For Pipeline agents, updates the Agent (`PUT /mia`): chat responses, native wake words with an 8-second active window, Deepgram `nova-3` with the wake phrases as boost words, and a system prompt. The model provider and model stay as saved in the dashboard.
4. Starts a local Express webhook listener (`POST /webhooks/meetstream`, health check on `GET /health`) and opens an ngrok tunnel unless `CALLBACK_URL` is set.
5. Calls `POST /bots/create_bot` with `meeting_link`, `bot_name`, `agent_config_id` and `callback_url` (`video_required: false`).
6. Prints the useful lifecycle events (`bot.in_waiting_room`, `bot.inmeeting`, `bot.recording`, `bot.stopped` with its reason) and the live transcript turns.
7. On Ctrl+C, calls `GET /bots/{bot_id}/remove_bot` and waits for the `bot.stopped` webhook (with `GET /bots/{bot_id}/detail` as a fallback) before closing the server and tunnel.

## What the program configures on the Agent

| Setting | Value |
| --- | --- |
| Mode | Pipeline (Realtime with a Chat response is also accepted) |
| Response | Meeting chat |
| Model | Provider and model as saved in the dashboard (for example OpenAI `gpt-4.1-mini`) |
| Transcription | Deepgram `nova-3`, English, wake phrases boosted |
| Activation | Native wake-word gate with an 8-second active window |

The wake-word list includes common transcription variants such as `hey assistant`, `okay assistant`, `hey bot`, `hey bought` and `hey bud`. Change the model and provider integrations in **MeetStream Dashboard > Agents**; each run re-applies the wake-word, transcription and response settings above.

## Prerequisites

- [Node.js 20 or newer](https://nodejs.org/)
- A MeetStream API key from <https://app.meetstream.ai>
- A saved MeetStream Hosted Agent with the OpenAI integration connected in the dashboard (the OpenAI key is not read by this project)
- An [ngrok authtoken](https://dashboard.ngrok.com/get-started/your-authtoken), unless `CALLBACK_URL` points at a public HTTPS endpoint you already have

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/MIA-chat-agent
npm install
cp .env.example .env   # then fill in the four required values
node index.js          # or: npm start
```

Find `MEETSTREAM_AGENT_CONFIG_ID` in the saved Agent details in the MeetStream dashboard.

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>` |
| `MEETSTREAM_AGENT_CONFIG_ID` | yes | ID of the saved Hosted Agent to attach to the bot |
| `MEETING_LINK` | yes | Full `https://` Zoom, Google Meet or Teams meeting link |
| `NGROK_AUTHTOKEN` | yes, unless `CALLBACK_URL` is set | Opens a temporary public tunnel for webhooks |
| `CALLBACK_URL` | no | Public `https://` webhook URL to use instead of ngrok |
| `PORT` | no | Local webhook port (default `3000`) |
| `BYPASS_WAKE_WORD` | no | `true` makes the agent answer every final transcript without a wake word (diagnostic only, default `false`) |

**Recording defaults.** This template records audio only. `video_required: false` is sent explicitly, because the REST API treats an omitted `video_required` as true, and audio only is faster to process and smaller to store. If you turn video on, also send `recording_config.video_layout: "speaker_view"` (the API default is `grid_view`, so speaker view has to be explicit); use `grid_view` only when you want the composited mosaic of everyone. Per-participant video (`video_separate_streams`) is never set here.

## Run

```console
npm start
```

Admit the bot from the meeting waiting room. After it joins, address it and give the request together:

```text
Hey bot, what are the action items?
Okay assistant, summarize the meeting.
```

The Hosted Agent posts its response in the meeting chat. Wait for one response before asking the next question so separate requests are not merged into one transcription turn.

Press Ctrl+C to ask MeetStream to remove the bot. The program keeps the webhook open until MeetStream confirms the bot stopped, then closes the local server and the ngrok tunnel.

## Webhook events

Every delivery carries `event`; most also carry `bot_event`. Every ending arrives once as `event: "bot.stopped"` and `bot_event` gives the reason: `bot.stopped` (clean exit or removal), `bot.kicked` (a participant removed the bot), `bot.notallowed` (never admitted), `bot.denied` (host refused), `bot.failed` (crashed). The program branches on `bot_event` and falls back to a case-insensitive `bot_status` only when `bot_event` is missing. `bot.error` is not terminal (a streaming provider hiccup; the bot keeps running). `bot.done` is the final event on every path.

## Test

```console
npm test
```

The tests mock `fetch`, so they run offline without an API key.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Fill in MEETSTREAM_API_KEY, ... in your .env file` | `.env` missing or still has placeholders | `cp .env.example .env` and fill in the required values |
| `MEETSTREAM_AGENT_CONFIG_ID does not match a saved Hosted Agent` | Wrong or partial ID | Copy the complete ID from the Agent details in the dashboard |
| 403 `MeetStream denied access` | Wrong API key (401 means no key was sent) | Check for a stray quote or trailing whitespace in `.env` |
| 400 `MeetStream rejected the bot settings` | Bad `meeting_link` or agent settings | Use the full meeting URL; re-save the Agent in the dashboard |
| 404 on `remove_bot` or `detail` | The bot already ended or the ID is wrong | Nothing to do; the program keeps waiting for a terminal state, then exits |
| `Port 3000 is already in use` | Another process on the port | Stop it or set `PORT` in `.env` |
| `Could not start ngrok` | Bad `NGROK_AUTHTOKEN` or no network | Fix the token, or set `CALLBACK_URL` to your own public HTTPS endpoint |
| Bot joins but does not respond | Agent ID, OpenAI or Deepgram integration not set up | Verify the Agent in **Dashboard > Agents** and the integrations under **Integrations** |
| Response is spoken instead of posted | Response type is not Chat | Save the Agent response type as **Chat** and deploy a new bot |
| No activation response | Wake phrase and request split across turns | Say the wake phrase and the request together, then pause |
| `bot.stopped` with `bot_event: bot.notallowed` / `bot.denied` | Never admitted, or the host refused | Admit the bot from the waiting room; ask the host to allow it |
| Bot remains after Ctrl+C | Bot still in a join/requeue transition | Keep the terminal open; the app retries for up to 90 seconds and waits for `MeetStream confirmed the bot stopped` |

## Related

- [What is MIA](https://docs.meetstream.ai/guides/mia/what-is-mia)
- [Create an agent](https://docs.meetstream.ai/guides/mia/create-an-agent)
- [MIA API guide](https://docs.meetstream.ai/guides/mia/mia-api-guide)
- [MIA custom configurations](https://docs.meetstream.ai/guides/mia/mia-custom-configurations)
- [Update agent config](https://docs.meetstream.ai/api-reference/api-endpoints/mia/update-agent-config)
- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Local webhook server](https://docs.meetstream.ai/guides/webhooks/local-webhook-server)
- Related templates: [../mia-wake-word-assistant](../mia-wake-word-assistant), [../mia-agent-crud](../mia-agent-crud), [../mia-realtime-agent](../mia-realtime-agent)
- Longer walkthrough: [BLOG.md](BLOG.md), quick start: [QUICKSTART.md](QUICKSTART.md)
