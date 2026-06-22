# Real-Time Transcription

Receive streaming transcription updates on your webhook URL while the bot is in the meeting.

Supports **Deepgram** and **AssemblyAI** streaming providers.

---

## Prerequisites

- Node.js 18+
- A MeetStream API key → [Get one here](https://app.meetstream.ai)
- A public webhook URL (use ngrok for local dev)

---

## 1. Install dependencies

```bash
cd realtime-transcription
npm install
```

---

## 2. Start the webhook server

```bash
node server.js
```

Server runs on `http://localhost:3000`.

---

## 3. Expose your local server publicly

MeetStream needs a publicly reachable URL to POST transcription events to.

**Option A — ngrok**

```bash
ngrok http 3000
# Copy the https://xxxx.ngrok.io URL
```

**Option B — Cloudflare Tunnel**

```bash
cloudflared tunnel --url http://localhost:3000
```

---

## 4. Create a bot with live transcription

```bash
MEETSTREAM_API_KEY=your_key \
WEBHOOK_URL=https://xxxx.ngrok.io \
node create-bot.js <meeting_url>
```

Example:

```bash
MEETSTREAM_API_KEY=sk_live_xxx \
WEBHOOK_URL=https://abc123.ngrok.io \
node create-bot.js https://meet.google.com/abc-defg-hij
```

The bot joins the meeting and MeetStream starts POSTing live transcription events to your server.

---

## 5. Switch providers

In `create-bot.js`, set:

```js
const PROVIDER = "deepgram";     // default
// or
const PROVIDER = "assemblyai";
```

---

## Server endpoints

| Endpoint | Description |
|---|---|
| `POST /webhook` | Receives live transcription events from MeetStream |
| `GET /health` | Health check |
| `GET /sessions/:botId` | View committed transcript for a session |

---

## Webhook payload reference

Each event POSTed to `/webhook` looks like:

```json
{
  "bot_id": "8ceabf49-d392-4c04-8e91-bd9601a0df6e",
  "speakerName": "Jane Smith",
  "timestamp": "2026-01-24T17:00:30.354452",
  "new_text": "hello",
  "transcript": "hello world",
  "words": [
    {
      "word": "hello",
      "start": 1.2,
      "end": 1.6,
      "confidence": 0.999,
      "word_is_final": true
    }
  ],
  "end_of_turn": false,
  "custom_attributes": {}
}
```

| Field | Notes |
|---|---|
| `new_text` | Incremental word or phrase — may be partial |
| `word_is_final` | `false` = interim, text may still change |
| `end_of_turn` | `true` = speaker finished their turn, safe to commit |
| `custom_attributes` | Echoed from your create-bot payload — use for session correlation |

---

## Extend it

Edit `onTurnComplete()` in `server.js` to wire in your own logic:
- Write completed turns to a database
- Trigger an LLM call on each speaker turn
- Push live captions to a frontend via SSE or WebSocket

---

## Resources

- [Live Transcription docs](https://docs.meetstream.ai/guides/transcription-recordings/create-bot-with-live-transcription)
- [Webhooks & Events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [API Reference](https://docs.meetstream.ai/api-reference)
