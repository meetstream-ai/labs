# MeetStream voice agent (BYOK pipeline)

A voice agent that joins a meeting, listens, and answers questions out loud.
Pipeline mode: **Deepgram** speech-to-text → **OpenAI** LLM → **ElevenLabs** voice.

MeetStream hosts the agent bridge, so there is nothing to deploy and no audio
infrastructure to run. The app makes exactly two API calls: create the agent
config, then send a bot carrying it into the meeting.

## Setup

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env     # then fill it in
```

`.env` needs your MeetStream API key (https://app.meetstream.ai/api-keys), your
Deepgram / OpenAI / ElevenLabs keys, an ElevenLabs voice id, and a meeting link.

> **Where your provider keys are used.** MeetStream runs the STT/LLM/TTS layers
> on its own bridge using the provider keys registered on your MeetStream
> account (app.meetstream.ai). The documented `POST /mia` body selects the
> *providers*, it does not carry their secrets, so this app validates that you
> hold all three keys and keeps them out of the request body. Register the same
> three keys in the dashboard before the first live run, or the agent joins and
> stays silent.

## Run

```bash
# Print both payloads, send nothing (works without a MeetStream key being live)
.venv/bin/python -m voice_agent --dry-run

# Create the agent config and send the bot into the meeting
.venv/bin/python -m voice_agent --meeting-link "https://meet.google.com/abc-defg-hij"

# Follow up
.venv/bin/python -m voice_agent --status BOT_ID
.venv/bin/python -m voice_agent --remove BOT_ID
```

## Behaviour worth knowing

- **Wake word is on by default** (`hey assistant`). The agent stays quiet until
  it is addressed, which is the right default for a real call. Set
  `WAKE_WORD_ENABLED=false` for an always-on agent.
- **`first_message` discloses that the bot is an AI** when it joins. Keep that.
- **`TRANSCRIBE_BOOSTWORDS`** is the fix for mishearings - put your product,
  company and people's names in it.
- **Video recording is off** (`video_required: false`), so the bot is audio
  only. Nothing here turns on per-participant streams.
- `--dry-run` never constructs an HTTP client, so it cannot reach the network.

## Tests

```bash
.venv/bin/python -m pytest
```

The suite injects a fake HTTP session everywhere, so no test touches the
network or needs a real key.

## Run against the local mock (no API key, no meeting)

[`../mock-meetstream`](../mock-meetstream) is a small offline stand-in for the MeetStream API. It answers with the same request and response shapes, and it plays a short meeting (lifecycle webhooks, live transcript, post-call files) when asked. `mock_e2e.py` starts the mock, runs this app against it, and prints PASS or FAIL.

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
python3 mock_e2e.py
```
