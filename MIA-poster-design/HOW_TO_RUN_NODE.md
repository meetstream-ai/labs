# Run MIA Poster Design with Node.js

Use this guide to run the application directly on the host without Docker. Node.js 20 or newer is required.

Do not run the Docker service at the same time. Both methods use the same port.

## 1. Prepare MeetStream

Create or edit a saved Hosted Agent using the exact settings in the [MeetStream dashboard prerequisites](README.md#meetstream-dashboard-prerequisites). You can set everything except the local MCP URL and its authorization header before starting this project.

## 2. Configure the environment

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

macOS or Linux:

```bash
cp .env.example .env
```

Fill in every required value in `.env`.

```text
MEETSTREAM_API_KEY=...
MEETSTREAM_AGENT_CONFIG_ID=...
MEETING_LINK=https://...
NGROK_AUTHTOKEN=...
PORT=3000
ADAPTER_ONLY=false
```

## 3. Install, test, and authenticate Canva

```bash
npm install
npm test
npm run check:canva
```

If a browser opens, sign in to the Canva account that should own generated designs. Continue after `Canva bridge verified: generate-design` appears.

## 4. Start the setup bridge

Windows PowerShell:

```powershell
$env:ADAPTER_ONLY='true'
npm start
```

macOS or Linux:

```bash
ADAPTER_ONLY=true npm start
```

Copy the complete public URL ending in `/mcp` from the `Bridge ready` line. Keep this terminal open while configuring MeetStream.

In the saved MeetStream agent:

1. Add the printed URL as the MCP server URL.
2. Set the MCP timeout to `90` seconds.
3. In a second terminal, run `npm run show:mcp-credential`.
4. Add an MCP header named `Authorization` and paste the command's complete `Bearer ...` output as its value.
5. Fetch the tools, allow only `generate-design`, and save the agent.

The credential is private. Do not put it in source control, screenshots, issues, or support messages.

## 5. Start the meeting bot

Stop the setup bridge with Ctrl+C and update `MEETING_LINK` in `.env` if necessary.

Windows PowerShell:

```powershell
$env:ADAPTER_ONLY='false'
npm start
```

macOS or Linux:

```bash
ADAPTER_ONLY=false npm start
```

Wait for `Bot is listening`, admit `MIA Poster Design Bot` to the meeting, and keep the terminal open. If ngrok produced a different public URL, update the saved MCP URL in MeetStream and start again.

## 6. Stop safely

Press Ctrl+C once and wait for:

```text
Bot removed; shutdown complete
```

Do not close the terminal while bot removal is pending.

## Later meetings

Update `MEETING_LINK` in `.env`, confirm `ADAPTER_ONLY=false`, then run `npm start`. Run `npm install` again only when `package-lock.json` changes.

For common errors and Canva account switching, see [Troubleshooting](README.md#troubleshooting).
