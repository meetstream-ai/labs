# MIA Hello World Voice Agent

Launch a basic MeetStream Infrastructure Agent (MIA) that joins a Zoom, Google Meet, or Microsoft Teams meeting, introduces itself, and responds verbally when addressed.

The agent behavior lives in the MeetStream Dashboard. This quickstart shows the code path: start a webhook listener, create a bot, attach your saved MIA agent with `agent_config_id`, and observe meeting lifecycle events.

## Prerequisites

- Node.js 18+
- A MeetStream API key
- A saved MIA voice agent in MeetStream Dashboard
- A meeting link for Zoom, Google Meet, or Microsoft Teams
- Either a public callback URL or an ngrok auth token

## 1. Install dependencies

```bash
cd labs/mia-hello-world-voice-agent
npm install
```

## 2. Configure environment

```bash
cp .env.example .env
```

Fill in:

```bash
MEETSTREAM_API_KEY=your_meetstream_api_key
MEETSTREAM_AGENT_CONFIG_ID=your_mia_hello_world_agent_id
MEETING_LINK=https://meet.google.com/abc-defg-hij
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
3. Create a MeetStream bot with your `MEETSTREAM_AGENT_CONFIG_ID`.
4. Log lifecycle events as the bot joins, enters, and leaves the meeting.

Say the configured wake phrase or address the agent the way you configured it in Dashboard. The expected hello-world behavior is a spoken response from the agent.

## Environment variables

| Variable | Required | Description |
|---|---:|---|
| `MEETSTREAM_API_KEY` | Yes | MeetStream API key. Sent as `Authorization: Token <key>`. |
| `MEETSTREAM_AGENT_CONFIG_ID` | Yes | Saved MIA agent ID from Dashboard. |
| `MEETING_LINK` | Yes | Zoom, Google Meet, or Teams meeting URL. |
| `CALLBACK_URL` | One of `CALLBACK_URL` or `NGROK_AUTHTOKEN` | Public base URL that forwards to this app. |
| `NGROK_AUTHTOKEN` | One of `CALLBACK_URL` or `NGROK_AUTHTOKEN` | Lets this app open an ngrok tunnel automatically. |
| `PORT` | No | Local server port. Defaults to `3000`. |
| `BOT_NAME` | No | Bot display name. Defaults to `MIA Hello World Voice Agent`. |

## How it works

The important field is `agent_config_id`:

```js
{
  meeting_link: MEETING_LINK,
  bot_name: BOT_NAME,
  video_required: false,
  agent_config_id: MEETSTREAM_AGENT_CONFIG_ID,
  callback_url: `${publicUrl}/webhooks/meetstream`
}
```

That field tells MeetStream to attach your saved hosted MIA runtime to the bot. Prompting, voice, model, wake words, and response behavior are configured in Dashboard.

## Cleanup

Press `Ctrl+C` to remove the bot from the meeting before the process exits.
