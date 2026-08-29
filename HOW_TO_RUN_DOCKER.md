# Run MIA Poster Design with Docker Compose

Use this guide for a repeatable container run with the project's pinned Node.js 20 image. Docker Desktop must be running. Node.js and npm are still needed on the host for the initial Canva authentication and helper commands.

Do not run `npm start` at the same time. Both methods use the same port.

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

Fill in every required value in `.env`:

```text
MEETSTREAM_API_KEY=...
MEETSTREAM_AGENT_CONFIG_ID=...
MEETING_LINK=https://...
NGROK_AUTHTOKEN=...
PORT=3000
ADAPTER_ONLY=false
MCP_AUTH_DIR=/absolute/path/to/.mcp-auth
```

`MCP_AUTH_DIR` is required for Docker. On Windows it is normally the `.mcp-auth` directory inside `%USERPROFILE%`; on macOS and Linux it is normally `$HOME/.mcp-auth`. Expand it to an absolute path in `.env`, for example `/Users/name/.mcp-auth` or `C:/Users/name/.mcp-auth`.

## 3. Install, test, and authenticate Canva

Run these commands on the host:

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
docker compose up --build -d
docker compose logs --tail 20
```

macOS or Linux:

```bash
ADAPTER_ONLY=true docker compose up --build -d
docker compose logs --tail 20
```

Copy the complete public URL ending in `/mcp` from the `Bridge ready` line.

In the saved MeetStream agent:

1. Add the printed URL as the MCP server URL.
2. Set the MCP timeout to `90` seconds.
3. Run `npm run show:mcp-credential` on the host.
4. Add an MCP header named `Authorization` and paste the command's complete `Bearer ...` output as its value.
5. Fetch the tools, allow only `generate-design`, and save the agent.

The credential is private. Do not put it in source control, screenshots, issues, or support messages.

## 5. Start the meeting bot

Recreate the setup container in full mode.

Windows PowerShell:

```powershell
$env:ADAPTER_ONLY='false'
docker compose up --build
```

macOS or Linux:

```bash
ADAPTER_ONLY=false docker compose up --build
```

Wait for `Bot is listening`, admit `MIA Poster Design Bot` to the meeting, and keep the terminal open. If ngrok produced a different public URL, update the saved MCP URL in MeetStream and start again.

## 6. Stop safely

For a foreground run, press Ctrl+C once and wait for:

```text
Bot removed; shutdown complete
```

If the service is detached, run `docker compose down`. Ctrl+C in `docker compose logs -f` only stops log viewing.

## Later meetings

Update `MEETING_LINK` in `.env`, then run:

```bash
docker compose up
```

Use `docker compose up --build` after changing source code, `package.json`, or `package-lock.json`.

For common errors and Canva account switching, see [Troubleshooting](README.md#troubleshooting).
