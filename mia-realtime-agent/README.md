# Build a Realtime Voice Agent for Meetings with MeetStream MIA

Create a realtime-mode MeetStream Infrastructure Agent (MIA) through the MeetStream API, attach it to a meeting bot, and get low-latency speech-to-speech replies in a live Google Meet, Zoom, or Microsoft Teams call. One realtime model hears the room and speaks back; there is no separate transcriber or TTS hop.

```console
npm install && cp .env.example .env && node index.js
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
git clone https://github.com/meetstream-ai/labs.git
cd labs/mia-realtime-agent
npm install
cp .env.example .env
```

Fill in at minimum:

```dotenv
MEETSTREAM_API_KEY=your_meetstream_api_key_here
MEETING_LINK=https://meet.google.com/abc-defg-hij
```

## Environment variables

| Name | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | API key from <https://app.meetstream.ai>, sent as `Authorization: Token <key>`. |
| `MEETING_LINK` | yes | Full Google Meet, Zoom or Microsoft Teams link. |
| `MEETSTREAM_AGENT_CONFIG_ID` | no | Reuse a realtime agent saved by an earlier run instead of creating one. |
| `MIA_REALTIME_PROVIDER` | no | Realtime model provider. Default `openai`. Must be enabled in your dashboard. |
| `MIA_REALTIME_MODEL` | no | Realtime model id. Default `gpt-4o-realtime-preview`. |
| `MIA_REALTIME_VOICE` | no | Voice name. Default `nova`. Validated against the OpenAI list below. |
| `MIA_SYSTEM_PROMPT` | no | System prompt for the model. Keep it short. |
| `MIA_AGENT_NAME` | no | Saved agent name. Default `Realtime Voice Assistant`. |
| `MIA_FIRST_MESSAGE` | no | Spoken as soon as the bot is admitted. |
| `BOT_NAME` | no | Bot display name in the meeting. Default `MIA Realtime Agent`. |
| `CALLBACK_URL` | no | Public HTTPS endpoint for per-bot lifecycle webhooks. |
| `DELETE_AGENT_ON_EXIT` | no | `true` deletes the agent config on exit. Default `false`. |
| `POLL_INTERVAL_SECONDS` | no | Seconds between `GET /bots/{id}/detail` polls. Default `10`. |
| `MEETSTREAM_BASE_URL` | no | API base URL. Default `https://api.meetstream.ai/api/v1`. |

**Recording defaults.** This template records audio only. `video_required: false` is sent explicitly, because the REST API treats an omitted `video_required` as true, and audio only is faster to process and smaller to store. If you turn video on, also send `recording_config.video_layout: "speaker_view"` (the API default is `grid_view`, so speaker view has to be explicit); use `grid_view` only when you want the composited mosaic of everyone. Per-participant video (`video_separate_streams`) is never set here.

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

| Symptom | Cause | Fix |
|---|---|---|
| `MEETSTREAM_API_KEY is missing from .env` | `.env` not created or key blank | `cp .env.example .env` and paste a real key. |
| HTTP 401 | No `Authorization` header sent | Check `.env` is loaded and the key is not empty. |
| HTTP 403 | Key wrong or revoked | The header must be `Authorization: Token <key>`, not `Bearer`. Regenerate the key. |
| HTTP 400 on `POST /mia` | Realtime provider or model id not available to your account | Check the dashboard integrations. |
| `MIA_REALTIME_VOICE ... is not an OpenAI realtime voice` | Typo in the voice name | Pick a name from the list above. |
| `points at a "pipeline" agent` | `MEETSTREAM_AGENT_CONFIG_ID` refers to a pipeline config | Unset it, or use the pipeline template. |
| Bot joins but never speaks | Saved agent lacks `response_type: "voice"`, or the realtime integration is not connected | Fix the config and reconnect the integration. |
| Bot stuck in the waiting room | Nobody admitted it; it leaves with `bot_event: bot.notallowed` after the timeout | Admit it from the People panel. |
| HTTP 429 | Rate limited | Slow down and retry. |
| HTTP 507 | Idempotent replay; the original request already succeeded | The earlier bot is the live one. |

## Related

- [What is MIA](https://docs.meetstream.ai/guides/mia/what-is-mia)
- [Create an agent](https://docs.meetstream.ai/guides/mia/create-an-agent)
- [MIA API guide](https://docs.meetstream.ai/guides/mia/mia-api-guide)
- [MIA custom configurations](https://docs.meetstream.ai/guides/mia/mia-custom-configurations)
- [Create agent config](https://docs.meetstream.ai/api-reference/api-endpoints/mia/create-agent-config)
- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [Error codes](https://docs.meetstream.ai/errors)
- Labs: [mia-voice-agent-pipeline](../mia-voice-agent-pipeline), [mia-wake-word-assistant](../mia-wake-word-assistant), [mia-agent-crud](../mia-agent-crud)
