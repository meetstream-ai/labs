# MIA Poster Design Quickstart

This guide covers the shortest reliable setup. See `README.md` for architecture, prompting details, account switching, security, and complete troubleshooting.

## What you need

- Docker Desktop running.
- Node.js 20+ and npm.
- MeetStream API key and saved MIA Agent ID.
- Meeting URL.
- ngrok auth token.
- Canva account with available generation credits.

## 1. Create `.env`

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

macOS or Linux:

```bash
cp .env.example .env
```

Open `.env` and fill in:

```text
MEETSTREAM_API_KEY=...
MEETSTREAM_AGENT_CONFIG_ID=...
MEETING_LINK=https://...
NGROK_AUTHTOKEN=...
PORT=3000
ADAPTER_ONLY=false
```

Never commit `.env`.

## 2. Install and authenticate Canva

```powershell
npm install
npm run check:canva
npm test
```

Complete Canva sign-in if a browser opens. Continue only after seeing:

```text
Canva bridge verified: generate-design
```

## 3. Start the setup bridge

Windows PowerShell:

```powershell
$env:ADAPTER_ONLY='true'
docker compose up --build -d
docker compose logs --tail 20
```

macOS or Linux:

```bash
ADAPTER_ONLY=true docker compose up --build -d
docker compose logs --tail 20
```

Copy the complete public URL ending in `/mcp` from the `Bridge ready` line.

## 4. Configure MeetStream

Configure the saved agent referenced by `MEETSTREAM_AGENT_CONFIG_ID`:

- Mode: `pipeline`
- OpenAI model: `gpt-4.1-mini`
- System prompt: complete `SYSTEM_PROMPT` from `src/deployBot.js`
- Response type: `chat`
- Response modality: `chat`
- Transcriber: Deepgram `nova-3`
- Wake words enabled with a 30-second timeout
- MCP URL: the printed public `/mcp` URL
- MCP timeout: `90` seconds recommended
- Allowed tools: only `generate-design`

Wake phrases:

```text
hey mia
okay mia
ok mia
hey assistant
okay assistant
hey bot
```

Generate the private MCP credential:

```powershell
npm run show:mcp-credential
```

Add it to the MCP server configuration:

```text
Header name:  Authorization
Header value: Bearer <generated-value>
```

Paste the command's complete output as the value. Fetch tools, select only `generate-design`, and save the agent.

## 5. Run the meeting bot

Windows PowerShell:

```powershell
$env:ADAPTER_ONLY='false'
docker compose up --build
```

macOS or Linux:

```bash
ADAPTER_ONLY=false docker compose up --build
```

Keep the terminal open. Admit `MIA Poster Design Bot` and wait for `Bot is listening`.

Speak this aloud while unmuted:

```text
Hey Assistant, create three birthday poster concepts for tomorrow at 6 PM. Use bright playful colors and sensible defaults for anything missing. Generate now.
```

MIA listens to meeting audio and posts Canva links in meeting chat. Wait up to 90 seconds for generation.

## 6. Stop safely

Press Ctrl+C once in the foreground Docker terminal. Do not close it until you see:

```text
Bot removed; shutdown complete
```

Ctrl+C in `docker compose logs -f` only stops viewing logs. Use `docker compose down` to stop a detached container.

## Later meetings

If code and dependencies have not changed:

```powershell
docker compose up
```

Use `docker compose up --build` after changing source code or dependencies.

## Local development alternative

```powershell
docker compose down
npm start
```

Docker and `npm start` run the same application. Never run them together because both use port `3000`.

## Fast troubleshooting

| Symptom | Action |
| --- | --- |
| `EADDRINUSE` | Run `docker compose down`, then use either Docker or `npm start`, not both. |
| Listening but no response | Unmute, speak the request aloud, start with `Hey Assistant`, and keep the request in one sentence. |
| Canva quota message | The integration worked; wait for Canva's limit to reset or switch to another Canva account. |
| Canva authentication failure | Run `npm run check:canva`. |
| MCP URL mismatch | Replace the saved MeetStream URL with the newest printed `/mcp` URL. |
| System prompt out of date | Copy the current `SYSTEM_PROMPT` from `src/deployBot.js` into MeetStream. |

For a different Canva account, stop the bot, back up `$env:USERPROFILE\.mcp-auth`, and rerun `npm run check:canva`. The full safe procedure is in `README.md`.
