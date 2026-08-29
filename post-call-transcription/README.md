# Post-Call Transcription

A MeetStream bot joins your meeting, records it, and saves the full transcript to a text file once the call ends.

**What it shows:** `create_bot` with a post-call transcription provider → webhook lifecycle → resolving `transcript_id` → fetching the finished transcript.

## Quick start

```bash
npm install
cp .env.example .env      # add your MEETSTREAM_API_KEY (+ ngrok token)
node index.js
```

Full walkthrough, including ngrok setup and troubleshooting: **[quickstart.md](./quickstart.md)**

## Prerequisites

- Node.js 18+
- A MeetStream API key - [get one here](https://app.meetstream.ai/api-key)
- An ngrok authtoken (to receive webhooks on your machine)

## How it works

1. Starts a local webhook server and opens an ngrok tunnel to it.
2. Creates a bot with `callback_url` pointed at the tunnel and a post-call transcript provider.
3. Listens for lifecycle events (envelope key is `event`) until `transcription.processed`.
4. Fetches the transcript by **`transcript_id`** (not `bot_id`) and writes it to disk.

## Docs

- [MeetStream Docs](https://docs.meetstream.ai) · [API Reference](https://docs.meetstream.ai/api-reference)
- [Webhooks and Events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
