# Build a Wake-Word Meeting Assistant with the MeetStream API

A MIA voice agent, deployed as a MeetStream meeting bot into Zoom, Google Meet or Microsoft Teams, that sits silently in the call and only answers when someone addresses it: "hey acme, what did we decide about pricing?" The wake-word gate runs inside MeetStream, so the LLM is never called for conversation that was not meant for it.

```console
npm install && node index.js
```

## Prerequisites

- Node.js 18 or newer (built-in `fetch` and ESM).
- A MeetStream API key from [app.meetstream.ai](https://app.meetstream.ai), set as `MEETSTREAM_API_KEY`. It is checked before any request is made; the `.env.example` placeholder counts as missing.
- The provider integrations the pipeline agent uses, connected under **Integrations** in the MeetStream dashboard. With the defaults that is **OpenAI** (model layer `gpt-4.1-mini` and voice `nova`) and **Deepgram** (transcriber `nova-3`). MeetStream hosts the agent and calls those providers itself, so this program reads no OpenAI or Deepgram key; a missing integration surfaces as a `POST /mia` or `create_bot` error, not as a local one.
- A full `https://` Zoom, Google Meet or Microsoft Teams link, set as `MEETING_LINK`, for a meeting where someone can admit the bot from the waiting room. Wake-word gating is pipeline only, so the saved agent must be a pipeline agent.
- Only if you set `CALLBACK_URL`: a public HTTPS URL MeetStream can reach for per-bot lifecycle webhooks (see [webhook-local-tunnel](../webhook-local-tunnel)). Without it the program follows the bot by polling `GET /bots/{id}/detail`, so no tunnel is needed.

## What it does

1. `POST /mia` saves a pipeline agent whose config includes a `wake_word` block.
2. `POST /bots/create_bot` sends a bot into your meeting with that `agent_config_id` attached.
3. MeetStream runs the gate. The model is only invoked after a wake phrase is heard.
4. Ctrl+C removes the bot with `GET /bots/{id}/remove_bot` and, optionally, deletes the agent.

## Why gate the assistant at all

An always-on assistant in a meeting fails in three ways at once:

- **It interrupts.** People pause mid-thought. An ungated agent reads that pause as its turn and talks over the room.
- **It answers the wrong people.** Side conversations, someone reading a Slack message out loud, a dog barking. All of it becomes input.
- **It costs money for nothing.** Every final transcript segment becomes an LLM call. A one-hour meeting with six people produces hundreds of segments that were never meant for the agent.

The `wake_word` block moves the gate into MeetStream, before the model runs. That is the difference between "filter the model's output" and "do not call the model", and it is what makes the cost math work for long meetings.

## Setup

```console
git clone https://github.com/meetstream-ai/labs.git
cd labs/mia-wake-word-assistant
npm install
cp .env.example .env
node index.js
```

Fill in at minimum:

```dotenv
MEETSTREAM_API_KEY=your_meetstream_api_key_here
MEETING_LINK=https://meet.google.com/abc-defg-hij
MIA_WAKE_WORDS=hey acme, ok acme, okay acme
```

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>` |
| `MEETING_LINK` | yes | Full `https://` Zoom, Google Meet or Teams link |
| `MEETSTREAM_AGENT_CONFIG_ID` | no | Reuse a wake-word agent saved by an earlier run instead of creating one |
| `MIA_WAKE_WORDS` | no | Comma-separated activation phrases (default `hey acme, ok acme, okay acme`) |
| `MIA_WAKE_WORD_TIMEOUT_SECONDS` | no | Seconds the agent stays awake after a phrase (default `30`) |
| `MIA_TRANSCRIBER_PROVIDER` / `MIA_TRANSCRIBER_MODEL` / `MIA_TRANSCRIBER_LANGUAGE` | no | Pipeline transcriber (default `deepgram` / `nova-3` / `en`) |
| `MIA_MODEL_PROVIDER` / `MIA_MODEL` / `MIA_SYSTEM_PROMPT` | no | LLM layer (default `openai` / `gpt-4.1-mini`) |
| `MIA_VOICE_PROVIDER` / `MIA_VOICE_ID` | no | Voice layer (default `openai` / `nova`) |
| `MIA_RESPONSE_TYPE` | no | `voice`, `chat` or `action` (default `voice`) |
| `MIA_AGENT_NAME` / `MIA_FIRST_MESSAGE` | no | Agent label and the one-time introduction |
| `BOT_NAME` | no | Bot display name in the meeting (default `Acme Assistant`) |
| `CALLBACK_URL` | no | Public `https://` webhook for per-bot lifecycle events |
| `DELETE_AGENT_ON_EXIT` | no | `true` deletes the agent config on exit (default `false`) |
| `POLL_INTERVAL_SECONDS` | no | Bot status poll interval (default `10`) |
| `MEETSTREAM_BASE_URL` | no | API base URL (default `https://api.meetstream.ai/api/v1`) |

**Recording defaults.** This template records audio only. `video_required: false` is sent explicitly, because the REST API treats an omitted `video_required` as true, and audio only is faster to process and smaller to store. If you turn video on, also send `recording_config.video_layout: "speaker_view"` (the API default is `grid_view`, so speaker view has to be explicit); use `grid_view` only when you want the composited mosaic of everyone. Per-participant video (`video_separate_streams`) is never set here.

## Run

```console
node index.js
```

Admit the bot from the waiting room. It introduces itself once, then stays quiet. Say a wake phrase and your question together:

```text
Hey acme, what are the action items so far?
Ok acme, summarize the last five minutes.
```

Press Ctrl+C to remove the bot.

## The wake_word block

```json
{
  "wake_word": {
    "enabled": true,
    "words": ["hey acme", "ok acme", "okay acme"],
    "timeout": 30
  }
}
```

| Field | Meaning |
| --- | --- |
| `enabled` | Turns the gate on. With `false`, the agent responds to everything it hears. |
| `words` | The activation phrases. Matching is on the transcribed text, so list the spellings a transcriber actually produces. |
| `timeout` | Seconds the agent stays awake after a phrase fires. A follow-up inside this window needs no phrase. |

### Choosing phrases

Wake-word matching happens on transcribed text, not on raw audio, which has one practical consequence: **the phrase you write is not always the phrase that arrives.** "hey acme" comes back as "hey akme", "hey, acme" or "hey acne" depending on the speaker and the microphone. A gate that never fires is almost always a spelling problem, not a config problem.

Two things help:

1. **List the variants.** Add the plausible mishearings of your brand name to `MIA_WAKE_WORDS`. Three to eight phrases is a reasonable range.
2. **Boost them at the transcriber.** This template passes the same phrase list to the transcriber as `boostwords`, which biases recognition toward the exact spellings the gate matches on. That is the single highest-leverage fix.

Two-syllable invented brand names are the hardest to catch. If your gate is unreliable, a longer distinct phrase like "hey acme assistant" usually outperforms a short one.

### Choosing a timeout

`timeout` is the length of the follow-up window, and it is a direct trade between convenience and false positives:

- **Short (5 to 10s)** forces the phrase on every request. Almost no false triggers, but conversational back-and-forth feels tedious.
- **Medium (20 to 40s)** lets a person ask a question, hear the answer, and ask a follow-up naturally. This template defaults to 30.
- **Long (60s+)** feels seamless with one speaker and badly wrong in a busy meeting, where unrelated conversation lands inside the open window.

Start at 30 and shorten it if the agent starts answering things that were not addressed to it.

## Response type

`MIA_RESPONSE_TYPE` controls how the agent answers:

- `voice` speaks in the meeting (default here)
- `chat` posts into the meeting chat, which is less disruptive during a live discussion
- `action` runs tools without producing an utterance

Chat mode pairs well with a shorter timeout, because a written answer does not interrupt anyone and there is less pressure to keep the window open.

## Attaching the agent to a bot

This is the entire MIA wiring on `create_bot`:

```javascript
{
  meeting_link: meetingLink,
  bot_name: 'Acme Assistant',
  video_required: false,
  agent_config_id: agentConfigId
}
```

Do not add `socket_connection_url` or `live_audio_required`. Those exist only for bring-your-own-bridge setups. With `agent_config_id`, MeetStream hosts the bridge.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `MEETSTREAM_API_KEY is missing from .env` | `.env` missing, empty or still a placeholder | `cp .env.example .env` and add your key |
| HTTP 401 / 403 | 401 = no key sent, 403 = key wrong or revoked | Header must be `Authorization: Token <key>`, not `Bearer` |
| HTTP 400 on `POST /mia` | A provider, model or voice is not enabled for your account | Enable the integration in the MeetStream dashboard |
| HTTP 400 on `create_bot` | Bad `MEETING_LINK` | Use the full meeting URL |
| HTTP 507 | Idempotent replay; the original request already succeeded | Treated as success |
| The gate never fires | The transcriber spells the phrase differently, or the phrase and question were split across turns | Say both in one breath, then pause; add mishearing variants to `MIA_WAKE_WORDS` (they are used as transcriber boostwords too) |
| The agent answers things nobody asked it | Follow-up window too long, or the phrase is too short | Lower `MIA_WAKE_WORD_TIMEOUT_SECONDS`, or use a longer, more distinctive phrase |
| `The saved agent has wake_word disabled` | The reused `MEETSTREAM_AGENT_CONFIG_ID` has no gate | Unset it to create a fresh gated agent |
| `Wake-word gating is a pipeline-mode feature` | The reused config is a realtime agent, which has no `wake_word` block | See [../mia-realtime-agent](../mia-realtime-agent) |
| Bot ends `NotAllowed` / `Denied` | Never admitted, or the host refused | Admit the bot from the waiting room |

## Related

- [What is MIA](https://docs.meetstream.ai/guides/mia/what-is-mia)
- [Create an agent](https://docs.meetstream.ai/guides/mia/create-an-agent)
- [MIA custom configurations](https://docs.meetstream.ai/guides/mia/mia-custom-configurations)
- [Create agent config](https://docs.meetstream.ai/api-reference/api-endpoints/mia/create-agent-config)
- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- Related templates: [../MIA-chat-agent](../MIA-chat-agent), [../mia-agent-crud](../mia-agent-crud), [../mia-realtime-agent](../mia-realtime-agent)
