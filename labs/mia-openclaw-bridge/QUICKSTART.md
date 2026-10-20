# MIA × OpenClaw quick start

1. Configure OpenClaw's Gateway with authenticated Chat Completions enabled:

   ```json5
   {
     gateway: {
       http: { endpoints: { chatCompletions: { enabled: true } } }
     }
   }
   ```

2. Copy `.env.example` to `.env` and set `MEETSTREAM_API_KEY`, `MEETING_URL`, `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`, and either `PUBLIC_BASE_URL` or `NGROK_AUTHTOKEN`.

3. Run:

   ```bash
   npm install
   npm run doctor
   npm start
   ```

4. Admit **OpenClaw Meeting Agent** when it enters the waiting room.

5. Say “Hey OpenClaw, what did we decide?” The finalized participant turn is sent to the selected OpenClaw agent, and its answer is posted through the MeetStream control channel.

6. Press Ctrl+C when finished. The bridge removes the bot and closes the ingress server.

The bridge's management API is available in plugin mode through `POST /v1/meeting-sessions/from-env`, protected by `X-Integration-Key` when `BRIDGE_API_KEY` is configured. Run `npm run check` for the offline suite.
