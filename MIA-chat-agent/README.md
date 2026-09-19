# MeetStream Hosted Meeting Agent

A small Node.js example that deploys a MeetStream Infrastructure Agent (MIA) into Google Meet, Zoom, or Microsoft Teams.

MeetStream hosts the agent runtime. The selected dashboard Agent controls transcription, activation instructions, the model, and chat responses. This project only starts the bot, receives lifecycle webhooks, and removes the bot when the program stops.

## Current Hosted Agent

The configured Agent uses:

| Setting | Value |
| --- | --- |
| Mode | Pipeline |
| Response | Meeting chat |
| Provider | OpenAI |
| Model | `gpt-4.1-mini` |
| Transcription | Deepgram `nova-3` |
| Activation | Native wake-word gate with an 8-second active window |

Change these settings in **MeetStream Dashboard > Agents**. New bot deployments use the saved dashboard configuration.

The native wake-word list includes common transcription variants such as `here assistant`, `hey bought`, and `hey bud`.

## Requirements

- [Node.js 20 or newer](https://nodejs.org/)
- [MeetStream API key](https://app.meetstream.ai/)
- A saved MeetStream Hosted Agent
- [ngrok authtoken](https://dashboard.ngrok.com/get-started/your-authtoken), unless `CALLBACK_URL` is set
- OpenAI integration configured in the MeetStream dashboard

The OpenAI key is not read by this project. MeetStream uses the integration attached to the Hosted Agent.

## Setup

Install dependencies:

```console
npm install
```

Copy `.env.example` to `.env`:

```dotenv
MEETSTREAM_API_KEY=your_meetstream_key_here
MEETSTREAM_AGENT_CONFIG_ID=your_agent_config_id_here
NGROK_AUTHTOKEN=your_ngrok_token_here
MEETING_LINK=https://meet.google.com/abc-defg-hij
```

Find `MEETSTREAM_AGENT_CONFIG_ID` in the saved Agent details in the MeetStream dashboard.

Optional:

```dotenv
PORT=3000
# CALLBACK_URL=https://your-domain.example/webhooks/meetstream
```

`CALLBACK_URL` replaces the temporary ngrok webhook tunnel and must be a public HTTPS address.

## Run

```console
npm start
```

Admit the bot from the meeting waiting room. After it joins, address it and give the request together:

```text
Hey bot, what are the action items?
Okay assistant, summarize the meeting.
```

The Hosted Agent posts its response in the meeting chat.

Press Ctrl+C to ask MeetStream to remove the bot, then close the local webhook server and ngrok tunnel.

## How Hosted Deployment Works

The create-bot request attaches the dashboard Agent. MeetStream automatically wires its hosted bridge:

```javascript
{
  meeting_link: meetingLink,
  agent_config_id: agentConfigId
}
```

There is no local speech-to-text, activation detector, LLM, or chat bridge.

## Model Choice and Token Usage

For Pipeline mode, choose an OpenAI text model in the MeetStream Agent editor:

| Model tier | Simple use case |
| --- | --- |
| Smaller model | Routine questions and short summaries |
| Balanced model | General meeting assistance |
| Stronger model | Difficult analysis where quality matters more than latency |

Transcription runs on your Deepgram key and responses on your OpenAI key.

## Test

```console
npm test
```

## Troubleshooting

- `Fill in MEETSTREAM_AGENT_CONFIG_ID`: copy the complete ID from the saved dashboard Agent.
- Bot joins but does not respond: verify the Agent ID and the OpenAI and Deepgram integrations.
- Response is spoken instead of posted: save both the documented response type and dashboard response modality as **Chat**, then deploy a new bot.
- No activation response: say the wake phrase and request together, then pause while the transcription turn completes.
- Bot remains after Ctrl+C: keep the terminal open. The app retries during MeetStream join/requeue transitions and waits up to 90 seconds for `MeetStream confirmed the bot stopped`.

See the official [MeetStream Hosted Agent guide](https://docs.meetstream.ai/guides/mia/create-an-agent).
