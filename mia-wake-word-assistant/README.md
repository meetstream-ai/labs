# MIA Wake Word Assistant

A MeetStream meeting assistant that sits silently in the call and only answers when someone addresses it: "hey acme, what did we decide about pricing?"

```console
npm install && node index.js
```

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

## Prerequisites

- Node.js 18 or newer (built-in `fetch` and ESM)
- A MeetStream API key from [app.meetstream.ai](https://app.meetstream.ai)
- Model, voice, and transcriber integrations enabled in your MeetStream dashboard
- A meeting link you can admit a bot into

## Setup

```console
npm install
cp .env.example .env
```

Fill in at minimum:

```dotenv
MEETSTREAM_API_KEY=your_meetstream_api_key_here
MEETING_LINK=https://meet.google.com/abc-defg-hij
MIA_WAKE_WORDS=hey acme, ok acme, okay acme
```

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

- **The gate never fires** - say the phrase and the question in one breath, then pause so the transcription turn completes. If it still misses, add mishearing variants to `MIA_WAKE_WORDS`; they are used as transcriber boostwords too.
- **The agent answers things nobody asked it** - lower `MIA_WAKE_WORD_TIMEOUT_SECONDS`, or use a longer, more distinctive phrase.
- **`The saved agent has wake_word disabled`** - the reused `MEETSTREAM_AGENT_CONFIG_ID` has no gate. Unset it to create a fresh gated agent.
- **`Wake-word gating is a pipeline-mode feature`** - the reused config is a realtime agent. Realtime configs have no `wake_word` block. See `mia-realtime-agent`.
- **HTTP 403** - the key is wrong or revoked. The auth header must be `Authorization: Token <key>`, not `Bearer`.
- **HTTP 400 on `POST /mia`** - a provider, model, or voice is not enabled for your account.
- **HTTP 507** - an idempotent replay. The original request already succeeded.

## Resources

- [MeetStream Docs](https://docs.meetstream.ai)
- [MIA guide](https://docs.meetstream.ai/guides/mia-meetstream-infrastructure-agents/create-mia)
