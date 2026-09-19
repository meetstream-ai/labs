# Live Meeting Captions in the Terminal with the MeetStream API

Live captions for a Zoom, Google Meet or Microsoft Teams meeting, rendered in your terminal while the meeting is still running. A MeetStream meeting bot joins with `live_transcription_required` and a streaming transcription provider, and POSTs each transcript chunk to a webhook on this machine.

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
bot.joining -> bot.in_waiting_room -> bot.inmeeting -> bot.recording
            -> bot.leaving -> bot.stopped -> manifest.completed / audio.processed
            -> bot.done
               (no transcription.processed in between for streaming-only bots)
```

A bot whose only transcript provider is a streaming one **never fires `transcription.processed`**. It still ends with `bot.done`, like every bot, so use `bot.done` as the "session finished" signal. Its `create_bot` response has no usable `transcript_id`, and `GET /transcript/{id}/get_transcript` returns **HTTP 202 forever** - not eventually, forever. An uncapped retry loop against a streaming-only bot spins until you kill it.

So the live chunks arriving at your webhook are the only transcript you get. If your consumer crashes mid-meeting, that data is gone.

Two ways to have both:

- **Persist the chunks yourself** as they arrive. This template keeps them in memory for the overlay; in production, write each chunk to a durable store inside the `/live` handler before doing anything else.
- **Re-transcribe afterwards.** The audio is recorded regardless of which transcript provider you chose. After `audio.processed`, run the transcribe-bot-audio endpoint with a post-call provider and you get a proper transcript with a real `transcript_id`. See the [re-transcribe-audio](../re-transcribe-audio) template.

## Prerequisites

- Node.js 18 or newer (uses built-in `fetch`)
- A MeetStream API key from [app.meetstream.ai](https://app.meetstream.ai)
- A public HTTPS URL pointing at this machine - MeetStream POSTs *to you*, so `localhost` cannot work. [ngrok](https://ngrok.com), Cloudflare Tunnel, or a deployed server all work.

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/live-captions-overlay
npm install
cp .env.example .env
```

Set `MEETSTREAM_API_KEY`. Start a tunnel and set `PUBLIC_URL` to its HTTPS URL:

```bash
ngrok http 3000
# -> https://abc123.ngrok-free.app
```

```
PUBLIC_URL=https://abc123.ngrok-free.app
```

The template appends the paths itself: `/live` for chunks, `/webhook` for lifecycle events. Then:

```bash
node index.js https://meet.google.com/xxx-xxxx-xxx
```

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>`. |
| `PUBLIC_URL` | yes | Public HTTPS base URL for this server. `/live` and `/webhook` are appended. |
| `MEETING_LINK` | one of | Meeting to join. The first CLI argument overrides it. |
| `PORT` | no | Local listen port. Default `3000`. |
| `PROVIDER` | no | Must be a `*_streaming` provider. Default `deepgram_streaming`. |
| `LANGUAGE` | no | Language code in the provider's format. Unset: provider default. |
| `DEEPGRAM_MODEL` | no | `deepgram_streaming` model. Default `nova-3`. |
| `TRANSCRIPTION_MODE` | no | `sentence` or `word` for Deepgram (default `sentence`); default `raw` for AssemblyAI. |
| `ENDPOINTING_MS` | no | Deepgram silence threshold that closes an utterance. Default `300`. |
| `ASSEMBLYAI_SPEECH_MODEL` | no | `assemblyai_streaming` `speech_model`; omitted when unset. |
| `SAMPLE_RATE` | no | `assemblyai_streaming` audio sample rate. Default `48000`. |
| `ENCODING` | no | `assemblyai_streaming` audio encoding. Default `pcm_s16le`. |
| `BOT_NAME` | no | Display name in the meeting. Default `MeetStream Captions Bot`. |
| `CAPTION_LINES` | no | Committed lines kept on screen. Default `10`. |
| `RETENTION_HOURS` | no | `recording_config.retention.hours`. Default `24` here; the API default when omitted is 720. |
| `REMOVE_BOT_ON_EXIT` | no | `false` leaves the bot in the meeting on Ctrl-C. Default `true`. |
| `MEETSTREAM_API_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |

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

**`POST /webhook`** receives lifecycle events. `event` is always present; most deliveries also carry `bot_event` with the specific name, and every one carries an ISO 8601 `timestamp`:

```json
{ "event": "bot.inmeeting", "bot_event": "bot.inmeeting", "bot_id": "...",
  "bot_status": "InMeeting", "message": "...", "status_code": 200,
  "timestamp": "2026-01-15T10:30:45Z", "custom_attributes": {} }
```

Worth knowing:

- **Every ending arrives as `event: "bot.stopped"`, and the reason is in `bot_event`**: `bot.stopped` (clean exit, 200), `bot.kicked` (a participant removed the bot, 200), `bot.notallowed` (never admitted from the waiting room, 500), `bot.denied` (host refused, 500), `bot.failed` (crashed, usually 500). Branch on `bot_event`, not `bot_status`: a kick and a clean exit both report `Stopped`. The template falls back to `bot_status` (case-insensitive) only when `bot_event` is missing.
- **`bot.error` is non-terminal.** It signals a streaming-provider hiccup; the bot stays in the meeting. Log it, do not tear down.
- **`bot.done` is the last event on every bot**, streaming-only included. `audio.processed` is not final; the overlay marks the session finished on `bot.done`.

**Both handlers ACK immediately** and do their work after responding. A slow webhook handler stalls the delivery pipeline and you start dropping captions.

**Every API call is checked, and nothing polls.** `src/client.js` makes exactly one request per call with a 30 s timeout: a 2xx or 507 is returned, any other status throws `HTTP <status> - <API message> - <hint>`, and no response at all throws `Network error calling <METHOD> <path>: ...`. There is no retry loop and no polling loop anywhere in this template; the process is a receiver that runs until Ctrl-C. The one wait that is not event-driven, the gap between `create_bot` and the first lifecycle webhook, is capped at 660 s (the default `waiting_room_timeout` plus a minute), after which the panel prints `no lifecycle event 660s after create_bot` with what to check.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `MEETSTREAM_API_KEY is not set` | No `.env`, or an empty key. Checked before the server starts. | `cp .env.example .env` and paste your key. |
| `MeetStream API error: HTTP 401 - ...` / `HTTP 403 - ...` | 401: no key was sent. 403: the key was rejected. | The header is `Authorization: Token <key>`; regenerate the key if 403 persists. |
| `MeetStream API error: HTTP 400 - ...` on `create_bot` | `live_transcription_required` was paired with a post-call provider (the local check catches the known names first), or a bad `meeting_link` / `RETENTION_HOURS`. | Use the `_streaming` variant; check the link and the retention value. |
| `MeetStream API error: HTTP 404 - ...` on `remove_bot` at Ctrl-C | The bot had already left and been cleaned up. | Nothing to do. |
| `MeetStream API error: HTTP 409 - ...` | An equivalent `create_bot` with the same `Idempotency-Key` is already in flight. | Re-run; each start uses a fresh key. |
| `MeetStream API error: HTTP 429 - ...` / `HTTP 5xx - ...` | Rate limited or a transient server problem. This template does not retry. | Wait a moment and re-run. |
| `HTTP 507 - idempotent replay, returning the original bot. Not an error.` | The same `Idempotency-Key` was seen before. | Nothing to do. |
| `Network error calling POST /bots/create_bot: no response within 30s` | No connectivity, or a wrong `MEETSTREAM_API_BASE_URL`. | Check the network and the base URL. |
| `create_bot did not return a bot_id` | Unexpected 2xx body. | Check the printed body; re-run. |
| `no lifecycle event 660s after create_bot` in the panel | MeetStream cannot reach `PUBLIC_URL`, or the bot already ended before the tunnel was up. | `curl https://<your-url>/health`, then `GET /bots/{bot_id}/detail`; Ctrl-C removes the bot. |
| `"<provider>" is a post-call provider` / `Unknown provider` / `"meeting_captions" uses the meeting platform's own captions` | `PROVIDER` cannot drive live captions. Rejected before any request. | Set one of `deepgram_streaming`, `assemblyai_streaming`, `jigsawstack_streaming`, `meetstream_streaming`. |
| `Provide a meeting link` / `PUBLIC_URL is not set` / `PORT must be a positive integer` | Required input missing or malformed. | Pass the link as the first argument or `MEETING_LINK`; set `PUBLIC_URL` and a numeric `PORT`. |
| `PUBLIC_URL must be an https:// URL` | MeetStream requires HTTPS. `localhost` and plain `http://` cannot receive webhooks. | Start `ngrok http 3000` and use its https URL. |
| `Port 3000 is already in use` | Another process owns the port. | Stop it or set `PORT`. |
| No captions, but the bot is in the meeting | MeetStream cannot reach `PUBLIC_URL`. | Check the tunnel is up and `curl https://<your-url>/health` returns `{"status":"ok"}`. |
| Captions arrive, then stop | A streaming provider dropped its connection (`bot.error`). The bot keeps running and usually recovers. | Watch the panel notes; nothing to restart. |
| Bot never joins | It is in the waiting room (`bot.in_waiting_room`). | Someone has to admit it. |
| `bot stopped (bot.notallowed, 500)` | Nobody admitted the bot before the waiting-room timeout. | Admit it faster, or raise `automatic_leave.waiting_room_timeout`. |
| Captions are choppy, one or two words at a time | `TRANSCRIPTION_MODE=word`. | Use `sentence` for readable captions. |
| Captions lag several seconds behind | Utterances are long. | Lower `ENDPOINTING_MS` for faster, more fragmented captions, or raise it for fewer, longer ones. |
| `GET /transcript/{id}` returns 202 forever afterwards | Expected. Streaming-only bots have no post-call transcript. | Use [re-transcribe-audio](../re-transcribe-audio). |
| Panel flickers or garbles | The overlay repaints a TTY. | Pipe output to a file; it automatically switches to append-only lines. |

## Related

- [Live transcription](https://docs.meetstream.ai/guides/transcription-recordings/live-transcription)
- [Deepgram streaming](https://docs.meetstream.ai/guides/transcription-recordings/providers/deepgram-streaming)
- [AssemblyAI streaming](https://docs.meetstream.ai/guides/transcription-recordings/providers/assemblyai-streaming)
- [Meeting captions provider](https://docs.meetstream.ai/guides/transcription-recordings/providers/meeting-captions)
- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Create bot payload reference](https://docs.meetstream.ai/api-reference/create-bot-payload-reference)
- [Transcribe bot audio](https://docs.meetstream.ai/api-reference/api-endpoints/transcription/transcribe-bot-audio)
- Sibling templates: [re-transcribe-audio](../re-transcribe-audio) turns a streaming-only bot's audio into a durable transcript; [realtime-transcription](../realtime-transcription) does live transcription over WebSocket instead of a webhook; [multi-provider-transcription](../multi-provider-transcription) is the post-call side of the provider list; [transcript-fetcher](../transcript-fetcher) covers post-call retrieval and why 202 needs a cap.
