# MIA Voice Agent (Pipeline Mode)

Create a pipeline-mode MeetStream Infrastructure Agent (STT + LLM + TTS), attach it to a bot, and let it speak in a live Google Meet, Zoom, or Microsoft Teams call.

```console
npm install && node index.js
```

## What it does

1. `POST /mia` saves a pipeline agent config and returns an `agent_config_id`.
2. `POST /bots/create_bot` sends a bot into your meeting with that `agent_config_id` attached.
3. The program polls `GET /bots/{id}/detail` and prints each status change.
4. Ctrl+C removes the bot with `GET /bots/{id}/remove_bot` and, optionally, deletes the agent.

MeetStream hosts the agent runtime. There is no local speech recognition, no local LLM call, and no websocket bridge in this template.

## Prerequisites

- Node.js 18 or newer (built-in `fetch` and ESM)
- A MeetStream API key from [app.meetstream.ai](https://app.meetstream.ai)
- Provider integrations enabled in your MeetStream dashboard for the model, voice, and transcriber you pick
- A meeting link you can admit a bot into

## Setup

```console
npm install
cp .env.example .env
```

Fill in at minimum:

```dotenv
MEETSTREAM_API_KEY=your_meetstream_api_key_here
MEETING_LINK=https://meet.google.com/abc-defg-hij
```

## Run

```console
node index.js
```

Admit the bot from the waiting room. It speaks its `first_message`, then answers what it hears. Press Ctrl+C to remove it.

The first run prints the new `agent_config_id`. Put it in `.env` as `MEETSTREAM_AGENT_CONFIG_ID` to reuse the same agent instead of creating a new config on every run.

## How pipeline mode works

Pipeline mode chains three independent layers. Each one is a separate provider you choose:

| Layer | Field | Job | Example |
| --- | --- | --- | --- |
| 1 | `transcriber` | speech in to text | Deepgram `nova-3` |
| 2 | `model` | text to text (the reasoning) | OpenAI `gpt-4.1` |
| 3 | `voice` | text to speech out | OpenAI `nova` |

The request body this template builds:

```json
{
  "agent_name": "Pipeline Voice Assistant",
  "mode": "pipeline",
  "model": {
    "provider": "openai",
    "model": "gpt-4.1",
    "system_prompt": "You are MIA, a spoken assistant in a live meeting."
  },
  "voice": { "provider": "openai", "voice_id": "nova" },
  "transcriber": { "provider": "deepgram", "model": "nova-3", "language": "en" },
  "agent": {
    "response_type": "voice",
    "first_message": "Hi, I am MIA. Ask me anything while the meeting runs.",
    "mcp_servers": []
  }
}
```

### Swapping a layer

Every layer is read from `.env`, so swapping one never touches the others.

Change the transcription engine:

```dotenv
MIA_TRANSCRIBER_PROVIDER=assemblyai
```

Change the reasoning model without touching speech:

```dotenv
MIA_MODEL_PROVIDER=openai
MIA_MODEL=gpt-4.1-mini
```

Change only the voice:

```dotenv
MIA_VOICE_ID=onyx
```

Transcription providers available for MIA and bot recording configs: `deepgram`, `assemblyai`, `sarvam`, `jigsawstack`, `meetstream`. Model and voice providers depend on which integrations are enabled in your dashboard, so a provider that is not connected there will be rejected with HTTP 400.

### Response type

`agent.response_type` decides how the agent replies:

- `voice` speaks in the meeting (what this template uses)
- `chat` posts into the meeting chat instead
- `action` runs tools without producing an utterance

## Attaching the agent to a bot

This is the entire MIA wiring on `create_bot`:

```javascript
{
  meeting_link: meetingLink,
  bot_name: 'MIA Voice Agent',
  video_required: false,
  agent_config_id: agentConfigId
}
```

Do not add `socket_connection_url` or `live_audio_required`. Those fields exist only for bring-your-own-bridge setups where you run the agent yourself. With `agent_config_id`, MeetStream runs the bridge.

## Pipeline vs realtime

Pipeline mode gives you provider-level control at the cost of three network hops per turn. If you want the lowest possible latency and are willing to accept one vendor's bundled speech-to-speech model, see the `mia-realtime-agent` template.

## Troubleshooting

- **`MEETSTREAM_API_KEY is missing from .env`** - copy `.env.example` to `.env` and paste a real key.
- **HTTP 403** - the key is wrong or revoked. The auth header must be `Authorization: Token <key>`, not `Bearer`.
- **HTTP 400 on `POST /mia`** - a provider, model id, or voice id is not valid for your account. Check which integrations are enabled in the dashboard.
- **Bot joins but never speaks** - confirm the saved agent has `mode: "pipeline"`, all three layers set, and `response_type: "voice"`. Fetch it with `GET /mia?agent_config_id=...` or use the `mia-agent-crud` template.
- **Bot is still in the meeting after Ctrl+C** - leave the terminal open until you see `Asked MeetStream to remove the bot`. You can also call `GET /bots/{id}/remove_bot` directly.
- **HTTP 507** - an idempotent replay. The original request already succeeded, so the earlier bot is the live one.

## Resources

- [MeetStream Docs](https://docs.meetstream.ai)
- [MIA guide](https://docs.meetstream.ai/guides/mia-meetstream-infrastructure-agents/create-mia)
