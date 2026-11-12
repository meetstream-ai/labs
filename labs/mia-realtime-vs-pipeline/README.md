# MIA Realtime vs Pipeline

Launch two equivalent MeetStream Infrastructure Agents (MIA) into the same meeting so you can compare realtime mode against pipeline mode.

This quickstart matches the dashboard task:

- **Realtime agent**: low-latency voice-first responses.
- **Pipeline agent**: transcription, model, TTS, wake-word/listening controls, and tool-capable orchestration.

The code creates one bot for each saved agent ID, logs lifecycle events, and keeps an in-memory comparison summary grouped by mode.

## Prerequisites

- Node.js 18+
- A MeetStream API key
- Two saved MIA agents in MeetStream Dashboard:
  - one in Real mode
  - one in Pipeline mode
- Deepgram or the pipeline agent's selected transcription provider connected in MeetStream Integrations
- A meeting link for Zoom, Google Meet, or Microsoft Teams
- Either a public callback URL or an ngrok auth token

## 1. Install dependencies

```bash
cd labs/mia-realtime-vs-pipeline
npm install
```

## 2. Configure environment

```bash
cp .env.example .env
```

Fill in:

```bash
MEETSTREAM_API_KEY=your_meetstream_api_key
MEETING_LINK=https://meet.google.com/abc-defg-hij
REALTIME_AGENT_CONFIG_ID=your_realtime_agent_id
PIPELINE_AGENT_CONFIG_ID=your_pipeline_agent_id
```

Then choose one callback option:

```bash
CALLBACK_URL=https://your-public-url.example.com
```

or:

```bash
NGROK_AUTHTOKEN=your_ngrok_token
```

## 3. Run it

```bash
npm start
```

The app will:

1. Start a local webhook server.
2. Expose it publicly if `NGROK_AUTHTOKEN` is set.
3. Create a realtime MIA bot and a pipeline MIA bot in the same meeting.
4. Log events with `custom_attributes.mode` set to `realtime` or `pipeline`.
5. Print a comparison summary when the process exits.

## Comparison checklist

Use the same prompt or wake phrase for each bot, then compare:

| Area | Realtime mode | Pipeline mode |
|---|---|---|
| Latency | Lowest-latency path; direct realtime model loop. | Higher latency because audio passes through transcription and orchestration before response. |
| Flexibility | Best for direct voice Q&A. | Better for workflows that need explicit transcription settings, wake-word/listening controls, MCP tools, or HTTP functions. |
| Voice | Realtime voice stack. | Separate STT and TTS providers. |
| Cost | Concentrated in realtime model usage. | Split across transcription, LLM, and TTS provider usage. |

The script records event timestamps. Exact speech-to-speech latency still depends on your meeting platform, agent settings, provider settings, and the way you prompt the bot during the live run.

## Environment variables

| Variable | Required | Description |
|---|---:|---|
| `MEETSTREAM_API_KEY` | Yes | MeetStream API key. Sent as `Authorization: Token <key>`. |
| `MEETING_LINK` | Yes | Zoom, Google Meet, or Teams meeting URL. |
| `REALTIME_AGENT_CONFIG_ID` | Yes | Saved Real-mode MIA agent ID. |
| `PIPELINE_AGENT_CONFIG_ID` | Yes | Saved Pipeline-mode MIA agent ID. |
| `CALLBACK_URL` | One of `CALLBACK_URL` or `NGROK_AUTHTOKEN` | Public base URL that forwards to this app. |
| `NGROK_AUTHTOKEN` | One of `CALLBACK_URL` or `NGROK_AUTHTOKEN` | Lets this app open an ngrok tunnel automatically. |
| `PORT` | No | Local server port. Defaults to `3001`. |
| `REALTIME_BOT_NAME` | No | Realtime bot display name. |
| `PIPELINE_BOT_NAME` | No | Pipeline bot display name. |

## Cleanup

Press `Ctrl+C` to remove both bots from the meeting before the process exits.
