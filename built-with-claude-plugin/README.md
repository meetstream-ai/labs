# Built with the MeetStream Claude plugin

Each app in this folder was written by Claude Code with only the [MeetStream Claude plugin](https://github.com/meetstream-ai/claude-plugin) loaded, from a one-paragraph request like a developer would type ("Build me an app that shows live captions from a meeting..."). We then checked every app offline against a local stand-in for the MeetStream API and kept only the apps that passed. Where an app needed a small fix to pass, the app's README says what changed.

They are useful two ways:

- as starting points, like the other templates in this repo;
- as a record of what the plugin's skills produce today, so you know what to check when your own coding agent builds on MeetStream.

| App | Language | What it does | Claude Code runs |
|---|---|---|---|
| [notetaker](./notetaker) | Node.js / TypeScript | Sends a bot from the command line; after the call, fetches the transcript and writes a markdown brief (summary, decisions, action items) through a swappable LLM interface; verifies signed workspace webhooks | 2 + a hand fix |
| [live-captions](./live-captions) | Python | Sends a bot with MeetStream's built-in live transcription and prints speaker-labelled captions in your terminal | 1 |
| [recording-archiver](./recording-archiver) | Python | Saves every finished recording to disk: mixed audio, video, and one audio file per participant | 1 |
| [talk-time](./talk-time) | Python | Per-speaker talk time, share, turns and longest stretch from a bot's speaker timeline, including the download-link answer for very long meetings | 2 |
| [recall-migration](./recall-migration) | Python | A small Recall.ai integration migrated to MeetStream (the original is kept beside it) | 2 |
| [chat-responder](./chat-responder) | Python | Bot answers `!help`, `!agenda` and `!time` in the meeting chat, treating chat text as untrusted | 2 |
| [dispatcher](./dispatcher) | Python | Sends a bot to every link in a list of Zoom, Google Meet and Teams links; skips bad links, waits out rate limits (`429` + `Retry-After`), prints a summary | 1 + a hand fix |
| [voice-byok](./voice-byok) | Python | A voice agent that answers questions out loud in the meeting, on your own Deepgram, OpenAI and ElevenLabs keys (saved in the MeetStream dashboard) | 1 |

"2" means a second run fixed what the first run got wrong after we tested it; the app README says what changed.

## Run one without an API key

Every app has a `mock_e2e.py`. It starts [`mock-meetstream`](./mock-meetstream), points the app at it, plays a short meeting, and prints `E2E PASS` or `E2E FAIL`. No API key, no meeting, no network.

```bash
cd live-captions
python3 -m venv .venv && .venv/bin/pip install -U pip && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest -q
python3 mock_e2e.py
```

To use an app for real, copy `.env.example` to `.env`, add your API key from [app.meetstream.ai](https://app.meetstream.ai/api-keys), and follow the app's README.

## Things worth knowing before you build your own

- Webhooks you set as a bot's `callback_url`, and live transcript chunks, arrive **unsigned**. Only workspace webhooks that you add in the dashboard carry `X-MeetStream-Signature`. Verify signatures on workspace webhooks; on per-bot URLs, use a hard-to-guess path instead.
- `video_required` defaults to `false`: bots record audio only unless you ask for video.
- Webhook and API bodies are flat JSON: `bot_id` and `event` sit at the top level of every webhook; `get_transcript` returns a top-level array; `get_chats` keeps messages under `chatMessages`; `get_speaker_timeline` returns `speaker_timeline_url` instead of inline chunks for very long meetings.
- Streaming transcription (`meetstream_streaming`) gives you live chunks only. If you also want a transcript after the call, call `POST /api/v1/bots/{bot_id}/transcribe` once the meeting ends.
