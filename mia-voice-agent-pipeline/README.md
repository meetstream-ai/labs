# Deploy a MIA Voice Agent into Meetings with the MeetStream API

Create a pipeline-mode MeetStream Infrastructure Agent (STT + LLM + TTS) with the MeetStream API, attach it to a meeting bot with `agent_config_id`, and let it speak in a live Google Meet, Zoom or Microsoft Teams call. MeetStream hosts the voice agent runtime; there is no local speech recognition, LLM call or websocket bridge in this template.

## What it does

1. `POST /mia` saves a pipeline agent config and returns an `agent_config_id`.
2. `POST /bots/create_bot` sends a bot into your meeting with that `agent_config_id` attached.
3. The program polls `GET /bots/{id}/detail` (capped by `POLL_MAX_ATTEMPTS`) and prints each status change until the bot reaches a terminal status.
4. Ctrl+C removes the bot with `GET /bots/{id}/remove_bot` and, optionally, deletes the agent.

## Prerequisites

- Node.js 18 or newer (built-in `fetch` and ESM)
- A MeetStream API key from [app.meetstream.ai](https://app.meetstream.ai)
- Provider integrations enabled in your MeetStream dashboard for the model, voice, and transcriber you pick
- A Zoom, Google Meet or Teams link you can admit a bot into

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/mia-voice-agent-pipeline
npm install
cp .env.example .env    # fill in MEETSTREAM_API_KEY and MEETING_LINK
node index.js
```

Admit the bot from the waiting room. It speaks its `first_message`, then answers what it hears. Press Ctrl+C to remove it.

The first run prints the new `agent_config_id`. Put it in `.env` as `MEETSTREAM_AGENT_CONFIG_ID` to reuse the same agent instead of creating a new config on every run.

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>`. |
| `MEETING_LINK` | yes | Full https:// Zoom, Google Meet or Teams link. |
| `MEETSTREAM_AGENT_CONFIG_ID` | no | Reuse an agent saved by an earlier run instead of creating one. |
| `MIA_TRANSCRIBER_PROVIDER` | no | Layer 1, speech to text. Default `deepgram`. |
| `MIA_TRANSCRIBER_MODEL` | no | Transcriber model. Default `nova-3`. |
| `MIA_TRANSCRIBER_LANGUAGE` | no | Transcriber language. Default `en`. |
| `MIA_MODEL_PROVIDER` | no | Layer 2, the LLM provider. Default `openai`. |
| `MIA_MODEL` | no | LLM model id. Default `gpt-4.1`. |
| `MIA_SYSTEM_PROMPT` | no | System prompt for the LLM. Default: a short spoken-assistant prompt. |
| `MIA_VOICE_PROVIDER` | no | Layer 3, text to speech provider. Default `openai`. |
| `MIA_VOICE_ID` | no | Voice id for that provider. Default `nova`. |
| `MIA_AGENT_NAME` | no | `agent_name` on the saved config. Default `Pipeline Voice Assistant`. |
| `MIA_FIRST_MESSAGE` | no | What the agent says when it joins. |
| `BOT_NAME` | no | Display name in the meeting. Default `MIA Voice Agent`. |
| `CALLBACK_URL` | no | Public https:// endpoint for lifecycle webhooks. |
| `DELETE_AGENT_ON_EXIT` | no | `true` deletes the agent config on exit. Default `false`. |
| `POLL_INTERVAL_SECONDS` | no | Seconds between status polls. Default `10`. |
| `POLL_MAX_ATTEMPTS` | no | Status poll cap. Default `720` (about 2 hours at 10 seconds). |
| `MEETSTREAM_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |

**Recording defaults.** This template records audio only. `video_required: false` is sent explicitly, because the REST API treats an omitted `video_required` as true, and audio only is faster to process and smaller to store. If you turn video on, also send `recording_config.video_layout: "speaker_view"` (the API default is `grid_view`, so speaker view has to be explicit); use `grid_view` only when you want the composited mosaic of everyone. Per-participant video (`video_separate_streams`) is never set here.

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

Pipeline mode gives you provider-level control at the cost of three network hops per turn. If you want the lowest possible latency and are willing to accept one vendor's bundled speech-to-speech model, see the [mia-realtime-agent](../mia-realtime-agent/README.md) template.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `MEETSTREAM_API_KEY is missing from .env` | No `.env` or empty key. | `cp .env.example .env` and paste a real key. |
| HTTP 401 / 403 | No key sent, or the key is wrong or revoked. | The header must be `Authorization: Token <key>`, not `Bearer`. Regenerate at <https://app.meetstream.ai>. |
| HTTP 400 on `POST /mia` | A provider, model id, or voice id is not valid for your account. | Check which integrations are enabled in the dashboard. |
| HTTP 400 on `create_bot` | Invalid `meeting_link`, or the `agent_config_id` does not exist. | Paste a full https:// link; fetch the agent with `GET /mia?agent_config_id=...`. |
| HTTP 404 on `GET /mia` | `MEETSTREAM_AGENT_CONFIG_ID` points at a deleted or foreign config. | Unset it so a fresh agent is created. |
| Bot joins but never speaks | The saved agent is not `mode: "pipeline"` with all three layers and `response_type: "voice"`. | Fetch it with `GET /mia?agent_config_id=...` or use the [mia-agent-crud](../mia-agent-crud/README.md) template. |
| Status ends at `NotAllowed` or `Denied` | Nobody admitted the bot from the waiting room, or the host refused it. | Admit the bot; re-run. |
| Bot is still in the meeting after Ctrl+C | The process exited before the remove call completed. | Leave the terminal open until you see `Asked MeetStream to remove the bot`, or call `GET /bots/{id}/remove_bot` directly. |
| HTTP 507 | An idempotent replay. The original request already succeeded. | The earlier bot is the live one; find it with `GET /bots`. |
| `poll budget ... exhausted` | The meeting outlasted `POLL_MAX_ATTEMPTS` polls. | Raise `POLL_MAX_ATTEMPTS`, or just re-run; the bot keeps running until removed. |

## Related

- [What is MIA](https://docs.meetstream.ai/guides/mia/what-is-mia)
- [Create an agent](https://docs.meetstream.ai/guides/mia/create-an-agent)
- [MIA API guide](https://docs.meetstream.ai/guides/mia/mia-api-guide)
- [MIA custom configurations](https://docs.meetstream.ai/guides/mia/mia-custom-configurations)
- [Create agent config](https://docs.meetstream.ai/api-reference/api-endpoints/mia/create-agent-config)
- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [Error reference](https://docs.meetstream.ai/errors)
- Templates: [mia-realtime-agent](../mia-realtime-agent/README.md), [mia-agent-crud](../mia-agent-crud/README.md), [mia-wake-word-assistant](../mia-wake-word-assistant/README.md)
