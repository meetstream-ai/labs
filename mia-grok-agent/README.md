# Put Grok in a Live Meeting with the MeetStream API

Send Grok into a Google Meet, Zoom, or Microsoft Teams call as a speaking participant. Grok hears everyone in the room and answers out loud. MeetStream provides the bot, the audio in and out, and the in-meeting presence; Grok (xAI) is the model behind the agent.

```console
npm install && cp .env.example .env && npm run check && npm start
```

Built on [mia-realtime-agent](../mia-realtime-agent). The API client (`src/api.js`) and env handling (`src/env.js`) are copied from it, plus `listAgents` from [mia-agent-crud](../mia-agent-crud) and the transcript calls from [transcript-fetcher](../transcript-fetcher). The agent config changes from OpenAI to Grok.

## What it does

1. `POST /mia` saves a realtime MIA config with `model.provider: "xai"` and returns an `agent_config_id`.
2. `POST /bots/create_bot` sends a bot named `Grok` into your meeting with that `agent_config_id` attached.
3. The program polls `GET /bots/{id}/detail` and prints each status change with an elapsed-time stamp, so you can line the log up against a screen recording.
4. Ctrl+C removes the bot with `GET /bots/{id}/remove_bot` and, optionally, deletes the agent.

MeetStream hosts the realtime bridge to xAI. This program opens no websocket and never handles an xAI key.

## Prerequisites

- Node.js 18 or newer
- A MeetStream API key from [app.meetstream.ai](https://app.meetstream.ai)
- xAI enabled as a realtime provider on that MeetStream account
- A meeting link you can admit a bot into

## Setup

```console
git clone https://github.com/meetstream-ai/labs.git
cd labs/mia-grok-agent
npm install
cp .env.example .env     # set MEETSTREAM_API_KEY and MEETING_LINK
npm run check            # verifies the key and the saved agent without joining anything
```

## Run

```console
npm start
```

Admit `Grok` from the waiting room. It stays quiet until someone talks to it, then answers out loud. Ctrl+C removes it.

The first run prints the new `agent_config_id`. Put it in `.env` as `MEETSTREAM_AGENT_CONFIG_ID` so later runs reuse that agent and skip the create step. Do this before you record.

| Command | What it does | Network |
| --- | --- | --- |
| `npm start` | Save or reuse the agent, join the meeting | yes |
| `npm run check` | Verify the API key and saved agent; no bot | read-only |
| `npm run dry-run` | Print both request bodies; no API key needed | none |
| `npm run demo` | Same as `npm start`, with the scripted `launch-demo` prompt (below) | yes |
| `npm run verify -- <bot_id>` | Check a finished call's recording for speech and the expected phrases (below) | read-only |
| `npm test` | Config builder, join and shutdown flow and verifier, run against a local mock of the MeetStream API | none |

## Reproduce the recorded demo

The plain agent answers freely. The first real Grok call was recorded with a scripted prompt that guides four answers (can you hear us, a launch idea, what to ship in a week, "you are in the meeting"). That prompt ships here as the `launch-demo` script, copied from the saved agent that made the recording:

```console
npm run demo
```

`--demo` is the same as `GROK_SCRIPT=launch-demo`. The built config matches the recording agent on every field it sets. The model still speaks the answers in its own words, and anything made from a take like this should say the answers were guided and credit Grok: "Created with Grok".

## Check the audio

A finished call's recording can be checked by code, so "Grok spoke" doesn't rest on someone listening:

```console
npm run verify -- <bot_id> --demo --transcribe
```

It transcribes the stored audio (or reads the bot's existing transcript), prints it, then checks that there is real speech and that the phrases Grok was guided to say were heard. `--expect "some phrase"` adds your own (repeatable). It exits non-zero on a miss. Start runs with `TRANSCRIBE=true` to have the transcript ready as soon as the call ends.

MeetStream records the call as one mixed channel. Sometimes the transcript labels Grok's lines with its own name, and sometimes it labels everything with the only named participant, so the labels are reported as extra evidence and don't decide pass or fail. The check proves the words are in the recording, and not how they sound. Tone and timing still need a listen. It also fails, correctly, when nobody asks the scripted questions.

## The Grok config

This follows MeetStream's "Realtime – xAI Grok" example in the [create agent config reference](https://docs.meetstream.ai/api-reference/api-endpoints/mia/create-agent-config). The `agent` settings match the saved agent that recorded the first real Grok call:

```json
{
  "agent_name": "Grok Meeting Demo",
  "mode": "realtime",
  "model": {
    "provider": "xai",
    "voice": "Ara",
    "system_prompt": "You are Grok, built by xAI, taking part in a live video meeting ...",
    "first_message": "",
    "temperature": 0.8
  },
  "agent": {
    "response_modality": "audio",
    "custom_functions": [],
    "mcp_servers": [],
    "preemptive_generation": true,
    "user_away_timeout": 15,
    "interruption_mode": "vad",
    "vad_type": "semantic_vad",
    "vad_eagerness": "medium",
    "vad_create_response": true,
    "vad_interrupt_response": true,
    "enable_interruptions": true,
    "interruptions": { "min_duration_seconds": 0.5, "word_threshold": 0 },
    "false_interruption_timeout": 2,
    "resume_false_interruption": true
  },
  "audio": { "sample_rate": 24000, "num_channels": 1 }
}
```

Realtime mode has no `voice`, `transcriber`, or `wake_word` block. Grok hears audio and speaks audio itself, which is why the replies come back quickly enough to feel like a participant.

`model.model` is omitted by default, as in MeetStream's example, so MeetStream picks its Grok voice model. Set `GROK_MODEL` to pin one.

## Environment variables

| Name | Required | Meaning |
| --- | --- | --- |
| `MEETSTREAM_API_KEY` | yes | Sent as `Authorization: Token <key>`. |
| `MEETING_LINK` | yes for `start` | Full Google Meet, Zoom, or Teams link. |
| `MEETSTREAM_AGENT_CONFIG_ID` | no | Reuse a saved Grok agent. Must be realtime with provider `xai`. |
| `GROK_VOICE` | no | Default `Ara`. Any of the 28 built-in Grok voices in [xAI's voice docs](https://docs.x.ai/developers/model-capabilities/audio/voice), in any case (`Ara` or `ara`). Other names print a warning, since they only work as custom xAI voice ids. |
| `GROK_MODEL` | no | Pin a Grok voice model id. Default: MeetStream's choice. |
| `GROK_FIRST_MESSAGE` | no | Spoken when the bot is admitted. Default empty: Grok waits to be addressed. |
| `GROK_SYSTEM_PROMPT` | no | Replaces the default meeting-participant prompt. |
| `GROK_SCRIPT` | no | `launch-demo` selects the scripted prompt the first real call was recorded with. Same as `--demo`. |
| `TRANSCRIBE` | no | `true` asks MeetStream for a post-call transcript, so `npm run verify` works right after the call. Default `false`. |
| `GROK_ALLOW_INTERRUPTIONS` | no | `true` (default) lets people talk over Grok. `false` for noisy rooms. |
| `BOT_NAME` | no | Display name in the meeting. Default `Grok`. |
| `MIA_AGENT_NAME` | no | Saved agent name. Default `Grok Meeting Demo`. |
| `CALLBACK_URL` | no | Public HTTPS endpoint for lifecycle webhooks. |
| `DELETE_AGENT_ON_EXIT` | no | `true` deletes the agent config on exit. Default `false`. |
| `POLL_INTERVAL_SECONDS` | no | Seconds between status polls. Default `5`. |
| `MEETSTREAM_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |

**Recording defaults.** This template records audio only. `video_required: false` is sent explicitly, because the REST API treats an omitted `video_required` as true, and audio only is faster to process and smaller to store. If you turn video on, also send `recording_config.video_layout: "speaker_view"` (the API default is `grid_view`, so speaker view has to be explicit); use `grid_view` only when you want the composited mosaic of everyone. Per-participant video (`video_separate_streams`) is never set here. Capture the demo video with your own screen recorder; see [Recording a take](#recording-a-take).

## Recording a take

For a clean recording of Grok answering in a real call:

1. Run `npm run check`, then one rehearsal with `npm run demo`. Copy the printed `agent_config_id` into `.env` as `MEETSTREAM_AGENT_CONFIG_ID`, so the day of the recording never creates an agent. Set `TRANSCRIBE=true` too.
2. Host the meeting yourself so you can admit the bot, and use a second participant so it looks like a real call. A headset or quiet room helps; otherwise set `GROK_ALLOW_INTERRUPTIONS=false` and recreate the agent, so room noise can't cut Grok off.
3. Start your screen recorder before `npm run demo`, capturing the meeting window and system audio. The `[mm:ss]` stamps in the terminal line up with the recording.
4. Keep the questions short. With the `launch-demo` script: "Grok, can you hear us?", then "Give us one idea to make a product launch more interesting", then "Are you actually in this meeting?". Avoid live news and prices; Grok can't verify them.
5. Thank it, then Ctrl+C, and wait for `Asked MeetStream to remove the bot`.
6. Run `npm run verify -- <bot_id> --demo`. It fails, correctly, if nobody asked the scripted questions.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| HTTP 403 | Key wrong or revoked | The header is `Token <key>`, not `Bearer`. Regenerate the key. |
| HTTP 400 on `POST /mia` | xAI is not enabled for the account, or the voice/model id is not accepted | Check the MeetStream dashboard integrations; try `GROK_VOICE=Ara` and no `GROK_MODEL`. |
| `points at a "pipeline" agent` / `not Grok` | `MEETSTREAM_AGENT_CONFIG_ID` is some other agent | Unset it and run again to create a Grok agent. |
| Bot joins but never speaks | Expected until someone addresses it (no greeting by default). If it stays silent when asked, the xAI integration is not connected or the agent lacks `response_modality: "audio"` | Run `npm run check`; recreate the agent. |
| Grok stops mid-sentence | Background noise counts as an interruption | `GROK_ALLOW_INTERRUPTIONS=false`, recreate the agent. |
| Status ends at `NotAllowed` or `Denied` | Nobody admitted the bot | Admit it from the People panel; re-run. |
| Bot still in the call after Ctrl+C | The process exited before the remove call finished | Wait for `Asked MeetStream to remove the bot`, or call `GET /bots/{id}/remove_bot`. |

## Related

- [What is MIA](https://docs.meetstream.ai/guides/mia/what-is-mia)
- [MIA custom configurations](https://docs.meetstream.ai/guides/mia/mia-custom-configurations)
- [Create agent config](https://docs.meetstream.ai/api-reference/api-endpoints/mia/create-agent-config)
- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- Templates: [mia-realtime-agent](../mia-realtime-agent), [mia-voice-agent-pipeline](../mia-voice-agent-pipeline), [mia-agent-crud](../mia-agent-crud), [mia-wake-word-assistant](../mia-wake-word-assistant), [transcript-fetcher](../transcript-fetcher)

Grok and xAI are trademarks of xAI. This template is not made, endorsed, or sponsored by xAI.
