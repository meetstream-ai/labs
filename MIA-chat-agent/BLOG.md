# How to Deploy a MeetStream Hosted Agent into a Meeting

A meeting assistant needs more than a bot that joins a call. It must listen, understand requests, and respond through the right channel. MeetStream Infrastructure Agents, or MIA, host that complete runtime so an application does not need to operate its own speech-to-text and language-model bridge.

This project is a minimal open-source example. It deploys a dashboard-configured Hosted Agent into Google Meet, Zoom, or Microsoft Teams, logs useful lifecycle events, and removes the bot safely when Ctrl+C is pressed.

---

## What You Will Build

The application will:

1. Load a MeetStream API key, Hosted Agent ID, and meeting link.
2. Start a small webhook listener for bot status events.
3. Create a secure ngrok callback during local development.
4. Attach the saved Hosted Agent to a new meeting bot.
5. Let MeetStream host transcription, wake-word detection, and chat responses.
6. Remove the bot during shutdown.

```text
Node.js app
  -> MeetStream create_bot API
  -> Hosted Agent
  -> meeting audio
  -> OpenAI Pipeline inside MeetStream
  -> meeting chat
```

---

## Prerequisites

You need Node.js 20 or newer, a MeetStream API key, an ngrok authtoken, and a saved Agent in the MeetStream dashboard.

The Agent used by this example is configured as:

- Pipeline mode
- Chat response
- OpenAI `gpt-4.1-mini`
- Deepgram `nova-3` with boosted native wake phrases and common recognition variants

Provider keys are configured in **MeetStream Dashboard > Integrations**.

Native wake gating stays active for 8 seconds after a recognized phrase.

---

## Project Setup

Install the project:

```console
npm install
```

Copy `.env.example` to `.env` and add:

```dotenv
MEETSTREAM_API_KEY=your_meetstream_key_here
MEETSTREAM_AGENT_CONFIG_ID=your_agent_config_id_here
NGROK_AUTHTOKEN=your_ngrok_token_here
MEETING_LINK=https://meet.google.com/abc-defg-hij
```

The Agent ID is displayed in the saved Agent details.

---

## Step 1: Validate the Local Settings

The application checks only the values needed to deploy the Hosted Agent:

```javascript
const required = [
  'MEETSTREAM_API_KEY',
  'MEETSTREAM_AGENT_CONFIG_ID',
  'MEETING_LINK'
];

const missing = required.filter(
  (name) => !process.env[name]?.trim()
);
```

OpenAI credentials, activation behavior, and prompts are intentionally absent. Those belong to the dashboard Agent.

---

## Step 2: Start the Webhook Listener

The local server receives lifecycle events:

```javascript
app.post('/webhooks/meetstream', (request, response) => {
  const event = request.body || {};
  botEvents.handle(event);
  const output = formatWebhookEvent(event);
  if (output) console.log(output);
  response.status(200).send('ok');
});
```

Routine processing events are hidden, while waiting-room, joined, removed, and failure events remain visible.

---

## Step 3: Create a Public Callback

During local development, ngrok exposes the webhook listener:

```javascript
tunnel = await startNgrokTunnel(config.port);

config.callbackUrl =
  `${tunnel.url().replace(/\/$/, '')}/webhooks/meetstream`;
```

A production deployment can provide its own public `CALLBACK_URL`.

---

## Step 4: Attach the Hosted Agent

The important deployment field is the Agent ID. MeetStream automatically wires its hosted bridge:

```javascript
const payload = {
  meeting_link: meetingLink,
  bot_name: 'Meeting Summary Bot',
  video_required: false,
  agent_config_id: agentConfigId,
  callback_url: callbackUrl
};
```

The application sends that payload to MeetStream:

```javascript
await fetch(
  'https://api.meetstream.ai/api/v1/bots/create_bot',
  {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  }
);
```

The `agent_config_id` selects the saved dashboard configuration and tells MeetStream to connect its Hosted Agent runtime.

---

## Step 5: Let MeetStream Run the Pipeline Agent

After the bot joins, MeetStream handles:

```text
Meeting audio
  -> Deepgram `nova-3` transcription
  -> native wake-word gate
  -> OpenAI `gpt-4.1-mini`
  -> meeting chat
```

There is no local audio decoder, transcription socket, OpenAI request, transcript array, or chat command. Editing the dashboard Agent changes new deployments without changing this repository.

For example:

```text
Hey bot, what are the action items?
Okay assistant, summarize the meeting.
```

The Hosted Agent opens an 8-second response window when it recognizes a configured wake phrase.

---

## Step 6: Remove the Bot Safely

The program listens for terminal shutdown signals:

```javascript
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
```

It removes the exact bot created by the current run:

```javascript
if (activeBot) {
  await removeBot(
    activeBot.apiKey,
    activeBot.id,
    botEvents.waitForTerminal
  );
  activeBot = null;
}
```

The app sends `GET /api/v1/bots/{bot_id}/remove_bot`. A bot can be requeued while joining, so the app retries the stop signal during that transition. Removal is complete only after a terminal webhook for the exact bot ID or a verified terminal detail state. The program then closes the webhook server and ngrok tunnel.

---

## Why Use a Hosted Agent?

A custom audio pipeline is useful when an application needs complete control over every audio frame. A Hosted Agent is a better fit when the goal is to demonstrate and ship MeetStream's agent platform:

- Agent behavior is configured in one dashboard.
- Transcription, wake-word, and model settings stay in the Hosted Agent.
- Provider integrations stay inside MeetStream.
- Activation instructions, prompts, and response type are managed centrally.
- The open-source example remains small and focused on deployment.

---

## Common Issues

### The bot joins but the Agent does not respond

Confirm that `MEETSTREAM_AGENT_CONFIG_ID` matches the saved Agent. MeetStream auto-wires the hosted bridge.

### The activation phrase gets no response

Say the wake phrase and request in one sentence, then pause while the transcription turn completes.

### The Agent speaks instead of using chat

Set both the response type and response modality to **Chat**, save the Agent, and deploy a new bot. Configuration changes apply to new deployments.

### A provider error appears

Check the OpenAI connection under **MeetStream Dashboard > Integrations**. Local provider keys are not used.

---

## Final Takeaway

This project now demonstrates the MeetStream Hosted Agent path directly: configure an Agent in the dashboard, pass its ID and the hosted bridge URLs to `create_bot`, and let MeetStream run the live meeting pipeline.

See the official [MeetStream MIA guide](https://docs.meetstream.ai/guides/mia/create-an-agent) for dashboard configuration and API details.
