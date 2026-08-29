# MIA Realtime Agent

Create a realtime-mode MeetStream Infrastructure Agent, attach it to a bot, and get low-latency spoken replies in a live Google Meet, Zoom, or Microsoft Teams call.

```console
npm install && node index.js
```

## What it does

1. `POST /mia` saves a realtime agent config and returns an `agent_config_id`.
2. `POST /bots/create_bot` sends a bot into your meeting with that `agent_config_id` attached.
3. The program polls `GET /bots/{id}/detail` and prints each status change.
4. Ctrl+C removes the bot with `GET /bots/{id}/remove_bot` and, optionally, deletes the agent.

MeetStream hosts the agent runtime. This template opens no websocket of its own.

## Prerequisites

- Node.js 18 or newer (built-in `fetch` and ESM)
- A MeetStream API key from [app.meetstream.ai](https://app.meetstream.ai)
- A realtime model provider integration enabled in your MeetStream dashboard
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

Admit the bot from the waiting room and start talking. Press Ctrl+C to remove it.

The first run prints the new `agent_config_id`. Put it in `.env` as `MEETSTREAM_AGENT_CONFIG_ID` to reuse the same agent on later runs.

## Pipeline vs realtime

This is the decision this template exists to illustrate.

| | Pipeline | Realtime |
| --- | --- | --- |
| Turn shape | audio to text, text to text, text to audio | audio to audio |
| Network hops per reply | three vendor calls | one |
| Perceived latency | higher, the sum of three stages | lower, the single reason to choose it |
| Transcriber choice | yours (`transcriber` block) | bundled inside the model |
| Voice choice | any TTS provider (`voice` block) | limited to the realtime model's voice list |
| LLM choice | any text model your account can use | only models that ship a realtime variant |
| Wake word | supported via the `wake_word` block | not part of a realtime config |
| Text transcript of the agent's own turns | produced by the transcriber layer | handled inside the model |
| Best for | control, cost tuning, per-layer swaps, wake-word gating | interruptible back-and-forth conversation |

Rule of thumb: choose realtime when a human is meant to converse with the agent and pauses are costly. Choose pipeline when you care more about which transcriber or which voice you use, want a wake word, or need a text model that has no realtime variant.

For the pipeline version see the `mia-voice-agent-pipeline` template. For wake-word gating, which is pipeline only, see `mia-wake-word-assistant`.

## The realtime config

```json
{
  "agent_name": "Realtime Voice Assistant",
  "mode": "realtime",
  "model": {
    "provider": "openai",
    "model": "gpt-4o-realtime-preview",
    "voice": "nova",
    "system_prompt": "You are MIA, a spoken assistant in a live meeting."
  },
  "agent": {
    "response_type": "voice",
    "first_message": "Hi, I am MIA. I am listening.",
    "mcp_servers": []
  }
}
```

Note what is absent compared with pipeline mode: no `voice` block, no `transcriber` block, no `wake_word` block. The voice lives inside `model` because it is the realtime model that produces the audio.

OpenAI realtime voices: `alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `nova`, `onyx`, `sage`, `shimmer`, `verse`. The template validates against this list before it calls the API so a typo fails locally instead of as an HTTP 400.

To use a different realtime provider, set `MIA_REALTIME_PROVIDER` and `MIA_REALTIME_MODEL` to a pair your dashboard integrations support. The voice list check is applied only to OpenAI.

## Latency notes

- Keep the system prompt short and tell the model to answer in one or two sentences. Long answers dominate perceived latency far more than the model choice does.
- `first_message` is spoken as soon as the bot is admitted. Keep it under a sentence so it does not talk over the room.
- Realtime mode does not remove the meeting platform's own audio buffering. Expect some delay even with an instant model.

## Attaching the agent to a bot

This is the entire MIA wiring on `create_bot`:

```javascript
{
  meeting_link: meetingLink,
  bot_name: 'MIA Realtime Agent',
  video_required: false,
  agent_config_id: agentConfigId
}
```

Do not add `socket_connection_url` or `live_audio_required`. Those fields exist only for bring-your-own-bridge setups where you host the agent yourself.

## Troubleshooting

- **`MEETSTREAM_API_KEY is missing from .env`** - copy `.env.example` to `.env` and paste a real key.
- **HTTP 403** - the key is wrong or revoked. The auth header must be `Authorization: Token <key>`, not `Bearer`.
- **HTTP 400 on `POST /mia`** - the realtime provider or model id is not available to your account. Check the dashboard integrations.
- **`MIA_REALTIME_VOICE ... is not an OpenAI realtime voice`** - pick a name from the list above.
- **`points at a "pipeline" agent`** - `MEETSTREAM_AGENT_CONFIG_ID` refers to a pipeline config. Unset it or use the pipeline template.
- **Bot joins but never speaks** - confirm the saved agent has `response_type: "voice"` and that the realtime integration is connected.
- **HTTP 507** - an idempotent replay. The original request already succeeded, so the earlier bot is the live one.

## Resources

- [MeetStream Docs](https://docs.meetstream.ai)
- [MIA guide](https://docs.meetstream.ai/guides/mia-meetstream-infrastructure-agents/create-mia)
