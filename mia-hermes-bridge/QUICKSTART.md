# Hermes in a Meeting: Simple Quick Start

## What this does

This project puts your Hermes assistant into a Google Meet, Zoom, or Microsoft Teams call.

People speak in the meeting. MeetStream turns that speech into text and sends it to Hermes. Hermes thinks, uses its tools or memory when needed, and posts its answer in the meeting chat.

```text
You speak → MeetStream hears you → Hermes answers → answer appears in chat
```

You do not need to invite Hermes as a normal person. MeetStream creates a meeting bot named **Hermes Meeting Agent**.

## How it works, simply

```text
You say “Hey Hermes, …”
        ↓
MeetStream joins the call and turns your speech into text
        ↓
This small bridge sends the question to your private Hermes gateway
        ↓
Hermes reasons, uses its tools or memory, and writes an answer
        ↓
MeetStream posts the answer into the meeting chat
```

MeetStream is the meeting specialist: it joins Google Meet, Zoom, or Teams, handles transcription, and sends messages back into the call. Hermes is the brain: it decides what to say and can use whatever tools and memory you configured. The bridge is only the safe translator between them; it does not need access to Hermes internals.

To connect a different self-hosted agent, keep MeetStream and the bridge, then point `HERMES_GATEWAY_URL` and `HERMES_API_KEY` at that agent's authenticated OpenAI-compatible `/v1` API. It needs to support either `/responses` or `/chat/completions`. That is all another builder has to replace.

## What you need once

Ask a technical teammate for help with this one-time setup if necessary:

1. A working Hermes installation.
2. A MeetStream account and API key.
3. Deepgram enabled in the MeetStream integrations page.
4. An ngrok account and authtoken.
5. Node.js 20.12 or newer.

Keep every API key private. Do not paste keys into a meeting, email, screenshot, or public chat.

## One-time setup

Run these exact commands in Terminal:

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/mia-hermes-bridge
npm install
npm run setup
```

If this example is placed in a differently named Labs folder, use that folder name after `cd labs/`.

Open `.env` in a text editor. Fill in these important lines:

```dotenv
NGROK_AUTHTOKEN=your-ngrok-token
MEETSTREAM_API_KEY=your-meetstream-api-key
HERMES_GATEWAY_URL=http://127.0.0.1:8080/v1
MEETING_URL=https://meet.google.com/abc-defg-hij
```

`MEETING_URL` is the only value most users change for each meeting.
You can leave `MEETSTREAM_MIA_CONFIG_ID` blank; the project creates or reuses the correct transport configuration automatically.

Hermes only answers when a speaker starts with one of these phrases: **“Hey Assistant,” “Hey Hermes,” “Hey Bot,” “Okay Agent,”** or **“Okay Bot.”** This keeps it from replying to normal meeting conversation.

Do **not** add these phrases in the MeetStream Agents/MIA dashboard. Leave MIA wake words disabled. This project applies `WAKE_WORDS` locally after MeetStream sends a finalized transcript to the bridge; setting MIA wake words can prevent the bridge from receiving the transcript at all.

## Start Hermes

Hermes needs its private API gateway running. The one-time Hermes configuration normally contains this in `~/.hermes/.env`:

```dotenv
API_SERVER_KEY=a-long-random-private-key
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8080
```

Start or verify Hermes:

```bash
hermes gateway install
hermes gateway status
```

If status says the gateway is supervised and running, Hermes is ready.

### If the default Hermes address does not work

The usual address is `http://127.0.0.1:8080/v1`, but the port can differ. Check it without exposing your secret key:

```bash
rg '^API_SERVER_(HOST|PORT)=' ~/.hermes/.env
```

If it shows `API_SERVER_PORT=9000`, set this in the project's `.env`:

```dotenv
HERMES_GATEWAY_URL=http://127.0.0.1:9000/v1
```

## Exact commands for every meeting

After the one-time setup, run these in order:

```bash
cd path/to/mia-hermes-bridge
hermes gateway status
npm run doctor
npm start
```

Do not use Docker for this local workflow. `npm start` runs the Node bridge directly on your computer and reaches local Hermes at `http://127.0.0.1:8080/v1`.

## Check everything without joining

In the project folder, run:

```bash
npm run doctor
```

This checks the file, credentials, MeetStream, ngrok configuration, and Hermes gateway. It does not create a bot.

## Send Hermes into the call

Start or join the meeting yourself, then run:

```bash
npm start
```

Leave that Terminal window open. This one command starts the bridge, opens ngrok, prepares MIA, and creates the bot. A successful start prints:

```text
Public bridge: https://your-address.ngrok-free.app
Bot created: ...
```

The public address is created by ngrok so MeetStream can reach your computer. The command then prints simple status lines as the bot hears and answers turns.

## Admit the bot

The meeting may show that **Hermes Meeting Agent** wants to join. Click **Admit**.

If nobody admits it, Hermes stays in the waiting room and cannot hear the meeting.

## Talk to Hermes

Speak normally, then pause for a moment so MeetStream knows your turn ended.

Hermes's answer appears in the meeting chat. This demo listens to spoken words; typing a message in Google Meet chat does not ask Hermes a question.

Use one wake phrase and one question, then wait for the reply. If captions merge several retries into one long block, the bridge uses the last wake-prefixed question.

Good first test:

> Hey Hermes, what is two plus two?

## Change to another meeting

Stop the current bot first, then change only this line in `.env`:

```dotenv
MEETING_URL=https://your-new-meeting-link
```

Run `npm start` again.

Google Meet, Zoom, and Microsoft Teams links are supported.

## Stop everything safely

Go to the Terminal window running `npm start` and press:

```text
Control + C
```

The bridge asks MeetStream to remove every bot it currently knows about, closes the ngrok tunnel, and exits.

You can also end the meeting normally. MeetStream's automatic-leave rules remove the bot when the call is empty or inactive.

## How to tell if it is working

While `npm start` is running, its status line eventually shows:

```text
[status] in_meeting | heard 1 | answered 1
```

Plain-English meaning:

- `in_meeting`: the bot was admitted.
- `heard 1`: MeetStream heard one complete spoken turn.
- `answered 1`: Hermes returned one answer to the meeting.

## Common problems

### The bot is waiting

Open the meeting's People panel and admit **Hermes Meeting Agent**.

### The bot joined, but there is no answer

- Keep the Terminal that ran `npm start` open. If it is closed, the bot can no longer reach Hermes.
- Speak instead of typing in meeting chat: “Hey Hermes, what is two plus two?”
- Start with a configured wake phrase and pause after the question.
- Confirm your microphone is not muted.
- Confirm meeting chat is enabled.
- Confirm the Hermes gateway and `npm start` are still running.

The terminal should progress to:

```text
[status] in_meeting | heard 1 | answered 1
```

If `heard` remains `0`, MeetStream has not delivered a finalized wake-word turn. If `heard` rises but `answered` remains `0`, read the `last_error` printed by the bridge and run `npm run doctor` again.

### Doctor says unauthorized

Check that `MEETSTREAM_API_KEY` came from the MeetStream dashboard and the Hermes key matches `API_SERVER_KEY`. Restart Hermes after changing its configuration.

### ngrok fails

Check `NGROK_AUTHTOKEN`. If a temporary URL stopped working, restart the bridge. A reserved `NGROK_DOMAIN` is more reliable for repeated use.

### The public ngrok URL shows a warning in a browser

That is the free ngrok browser-warning page. It applies to ordinary browser visitors and does not stop MeetStream's server-to-server webhook and WebSocket connections. Do not paste meeting or API secrets into that page.

### Hermes is unavailable

Run:

```bash
hermes gateway status
```

If needed, restart it:

```bash
hermes gateway restart
```

## Privacy reminder

Meeting speech is sent through MeetStream's transcription pipeline and then to Hermes. Hermes may use configured model providers and tools. Only use this bot in meetings where participants know and agree that an AI assistant is present.

For engineering details, security notes, APIs, and troubleshooting counters, see [README.md](README.md).
