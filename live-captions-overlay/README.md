# live-captions-overlay

Live meeting captions in your terminal, streamed from MeetStream over a webhook while the meeting is still running.

```bash
cp .env.example .env      # add MEETSTREAM_API_KEY and PUBLIC_URL
npm install
ngrok http 3000           # in another terminal, then put the URL in PUBLIC_URL
node index.js https://meet.google.com/xxx-xxxx-xxx
```

## What it does

Starts an Express server, sends a bot with live transcription enabled, and renders a rolling caption panel as chunks arrive:

```
LIVE CAPTIONS
recording - captions will appear as people speak · 47 chunk(s) received
--------------------------------------------------------------------------------
[14:22:07] Alice
    So the pricing change goes live on the first.
[14:22:14] Bob
    Do existing customers get grandfathered?
[14:22:19] Alice ...
    Yes, for twelve months
```

The last line is in-progress: the streaming provider is still revising it, so it is redrawn in place rather than committed.

## Two rules this template exists to teach

### 1. `live_transcription_required` requires a `*_streaming` provider

```json
{
  "live_transcription_required": { "webhook_url": "https://you.example.com/live" },
  "recording_config": {
    "transcript": { "provider": { "deepgram_streaming": { "model": "nova-3" } } }
  }
}
```

Combining `live_transcription_required` with a **post-call** provider (`deepgram`, `assemblyai`, `sarvam`, `jigsawstack`, `meetstream`) is an **HTTP 400**. Post-call engines only run once the recording is finished, so there is nothing for them to send while the meeting is happening. The names look almost identical - `deepgram` and `deepgram_streaming` differ by one suffix - and that suffix is the whole difference between a live feed and a 400.

Streaming providers:

| Provider | Notes |
|---|---|
| `deepgram_streaming` | Default. `transcription_mode: "sentence"` gives punctuated sentences, which is what captions want. |
| `assemblyai_streaming` | Takes `speech_model` (singular string) - the post-call `assemblyai` provider takes `speech_models`, an array. |
| `jigsawstack_streaming` | |
| `meetstream_streaming` | In-house. |

`meeting_captions` is not in this list. It reads the meeting platform's own captions and exposes them as a `caption_file` on `GET /bots/{bot_id}/detail` after the meeting - it does not POST chunks to your webhook.

The template checks the provider before calling the API and explains the problem instead of letting you decode a 400.

### 2. A streaming-only bot produces no post-call transcript

This is the trade-off, and it surprises people:

```
bot.joining → bot.in_waiting_room → bot.inmeeting → bot.recording
            → bot.leaving → bot.stopped → manifest.completed → audio.processed
                                                                     ▲
                                                        streaming bots END here
```

A bot whose only transcript provider is a streaming one **never fires `transcription.processed` and never fires `bot.done`**. Its `create_bot` response has no usable `transcript_id`, and `GET /transcript/{id}/get_transcript` returns **HTTP 202 forever** - not eventually, forever. An uncapped retry loop against a streaming-only bot spins until you kill it.

So the live chunks arriving at your webhook are the only transcript you get. If your consumer crashes mid-meeting, that data is gone.

Two ways to have both:

- **Persist the chunks yourself** as they arrive. This template keeps them in memory for the overlay; in production, write each chunk to a durable store inside the `/live` handler before doing anything else.
- **Re-transcribe afterwards.** The audio is recorded regardless of which transcript provider you chose. After `audio.processed`, run `POST /bots/{bot_id}/transcribe` with a post-call provider and you get a proper transcript with a real `transcript_id`. See the `re-transcribe-audio` template.

## Prerequisites

- Node.js 18 or newer (uses built-in `fetch`)
- A MeetStream API key from [app.meetstream.ai](https://app.meetstream.ai)
- A public HTTPS URL pointing at this machine - MeetStream POSTs *to you*, so `localhost` cannot work. [ngrok](https://ngrok.com), Cloudflare Tunnel, or a deployed server all work.

## Setup

```bash
cp .env.example .env
```

Set `MEETSTREAM_API_KEY`. Start a tunnel and set `PUBLIC_URL` to its HTTPS URL:

```bash
ngrok http 3000
# → https://abc123.ngrok-free.app
```

```
PUBLIC_URL=https://abc123.ngrok-free.app
```

The template appends the paths itself: `/live` for chunks, `/webhook` for lifecycle events.

## Run

```bash
node index.js https://meet.google.com/xxx-xxxx-xxx

# a different streaming provider
PROVIDER=assemblyai_streaming node index.js <meeting_link>

# word-level chunks instead of sentences (more frequent, choppier)
TRANSCRIPTION_MODE=word node index.js <meeting_link>

# snappier captions: close an utterance after 150ms of silence
ENDPOINTING_MS=150 node index.js <meeting_link>
```

Ctrl-C removes the bot from the meeting (`GET /bots/{bot_id}/remove_bot` - note it is a GET) unless you set `REMOVE_BOT_ON_EXIT=false`.

## How it works

**`POST /live`** receives transcript chunks:

```json
{
  "speakerName": "Alice",
  "timestamp": "2026-01-15T10:30:45Z",
  "transcript": "Can you walk me through pricing?",
  "words": [
    { "word": "Can", "punctuated_word": "Can", "start": 0.24, "end": 0.52,
      "confidence": 0.99, "speaker": 0, "speaker_confidence": 0.98 }
  ]
}
```

The text is in `transcript`. Some streaming providers additionally flag turn boundaries; when `end_of_turn` is present and `false`, the overlay replaces the in-progress line instead of committing a new one. When the flag is absent every chunk is treated as final.

**`POST /webhook`** receives lifecycle events. The envelope key is **`event`**:

```json
{ "event": "bot.inmeeting", "bot_id": "...", "bot_status": "InMeeting",
  "message": "...", "status_code": 200, "custom_attributes": {} }
```

Worth knowing:

- **`bot.stopped` is always `status_code: 200`**, whatever the reason. The reason is in `bot_status`: `Stopped` (clean), `NotAllowed` (never admitted from the waiting room), `Denied` (host refused), `Error`.
- **`bot.error` is non-terminal.** It signals a streaming-provider hiccup; the bot stays in the meeting. Log it, do not tear down.
- **`audio.processed` is the last event you will see** on a streaming-only bot. The overlay says so explicitly when it arrives.

**Both handlers ACK immediately** and do their work after responding. A slow webhook handler stalls the delivery pipeline and you start dropping captions.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MEETSTREAM_API_KEY` | - | Required. Sent as `Authorization: Token <key>`. |
| `MEETING_LINK` | - | Meeting to join. The first CLI argument overrides it. |
| `PUBLIC_URL` | - | Required. Public HTTPS base URL for this server. |
| `PORT` | `3000` | Local listen port. |
| `PROVIDER` | `deepgram_streaming` | Must be a `*_streaming` provider. |
| `LANGUAGE` | - | Language code in the provider's format. |
| `DEEPGRAM_MODEL` | `nova-3` | `deepgram_streaming` model. |
| `TRANSCRIPTION_MODE` | `sentence` / `raw` | `sentence` or `word` for Deepgram. |
| `ENDPOINTING_MS` | `300` | Deepgram silence threshold that closes an utterance. |
| `ASSEMBLYAI_SPEECH_MODEL` | - | `assemblyai_streaming`; omitted when unset. |
| `SAMPLE_RATE` / `ENCODING` | `48000` / `pcm_s16le` | `assemblyai_streaming` audio format. |
| `BOT_NAME` | `MeetStream Captions Bot` | Display name in the meeting. |
| `CAPTION_LINES` | `10` | Committed lines kept on screen. |
| `RETENTION_HOURS` | `24` | `recording_config.retention.hours`. |
| `REMOVE_BOT_ON_EXIT` | `true` | Remove the bot on Ctrl-C. |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `HTTP 400` on `create_bot` | `live_transcription_required` was paired with a post-call provider. Use the `_streaming` variant. |
| No captions, but the bot is in the meeting | MeetStream cannot reach `PUBLIC_URL`. Check the tunnel is up and `curl https://<your-url>/health` returns `{"status":"ok"}`. |
| `PUBLIC_URL must be an https:// URL` | MeetStream requires HTTPS. `localhost` and plain `http://` cannot receive webhooks. |
| Captions arrive, then stop | Check for `bot.error` notes in the panel - a streaming provider dropped its connection. The bot keeps running and usually recovers. |
| Bot never joins | Watch for `bot.in_waiting_room`. Someone has to admit it. |
| `bot.stopped` with `NotAllowed` | Nobody admitted the bot before the waiting-room timeout. |
| Captions are choppy, one or two words at a time | `TRANSCRIPTION_MODE=word`. Use `sentence` for readable captions. |
| Captions lag several seconds behind | Raise `ENDPOINTING_MS` for fewer, longer utterances, or lower it for faster, more fragmented ones. |
| `GET /transcript/{id}` returns 202 forever afterwards | Expected. Streaming-only bots have no post-call transcript. Use `re-transcribe-audio`. |
| Panel flickers or garbles | The overlay repaints a TTY. Piping output to a file automatically switches to append-only lines. |

## Related templates

- `re-transcribe-audio` - turn a streaming-only bot's audio into a durable transcript
- `realtime-transcription` - live transcription over WebSocket instead of webhook
- `multi-provider-transcription` - the post-call side of the provider list
- `transcript-fetcher` - post-call retrieval, and why 202 needs a cap
