# Create and Manage MIA Voice Agent Configs with the MeetStream API

An admin CLI for saved MIA (MeetStream Infrastructure Agent) configs: the voice agent recipes a MeetStream meeting bot runs when it joins a Zoom, Google Meet or Microsoft Teams call. Create, list, inspect, update and delete them from the terminal instead of clicking through the dashboard, then attach one to a bot with a single `agent_config_id` on `create_bot`.

```console
npm install && node index.js list
```

## What it does

One command per route:

| Command | Route |
| --- | --- |
| `create` | `POST /mia` |
| `list` | `GET /mia` |
| `get <id>` | `GET /mia?agent_config_id=...` |
| `update <id>` | `PUT /mia` (body carries `agent_config_id`) |
| `delete <id>` | `DELETE /mia?agent_config_id=...` |

An agent config is a saved recipe: mode, model, voice, transcriber, response type, wake word. You attach one to a meeting bot by passing its `agent_config_id` on `create_bot`. That single field is the whole integration. MeetStream hosts the agent bridge, so there are no websocket fields to wire up.

## Prerequisites

- Node.js 18 or newer (built-in `fetch` and ESM)
- A MeetStream API key from [app.meetstream.ai](https://app.meetstream.ai)

## Setup

```console
git clone https://github.com/meetstream-ai/labs.git
cd labs/mia-agent-crud
npm install
cp .env.example .env      # paste MEETSTREAM_API_KEY
node index.js list
```

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>`. The placeholder value from `.env.example` is rejected. |
| `MEETSTREAM_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |

## Run

```console
node index.js --help
```

### List everything

```console
node index.js list
node index.js list --json
```

### Create from a preset

Three presets ship with the tool: `pipeline`, `realtime`, `wake-word`.

```console
node index.js create --preset pipeline
node index.js create --preset pipeline --name "Support Bot" --model gpt-4.1-mini
node index.js create --preset wake-word --set wake_word.words='["hey acme","ok acme"]'
```

Check the body before it is sent:

```console
node index.js create --preset realtime --dry-run
```

The `wake-word` preset also seeds `transcriber.boostwords` with the same phrases, which biases speech recognition toward the spellings the gate matches on. If you change `wake_word.words`, change `transcriber.boostwords` to match:

```console
node index.js create --preset wake-word \
  --set wake_word.words='["hey acme","ok acme"]' \
  --set transcriber.boostwords='["hey acme","ok acme"]'
```

### Create from a file

```console
node index.js create --file ./my-agent.json
```

`--preset` and `--file` combine: the file is deep-merged on top of the preset, so a file only needs the parts that differ.

### Inspect one

```console
node index.js get 1f2e3d4c-0000-0000-0000-000000000000
node index.js get 1f2e3d4c-0000-0000-0000-000000000000 --json
```

### Update

`PUT /mia` is a partial update: it sends `agent_config_id` plus the blocks you name, and leaves the rest as they are.

```console
node index.js update <id> --prompt "Answer in one sentence."
node index.js update <id> --model gpt-4.1
node index.js update <id> --set voice.voice_id=onyx
node index.js update <id> --set wake_word.enabled=true --set wake_word.timeout=20
node index.js update <id> --file ./patch.json
```

Because `--set` uses dotted paths, it replaces whole leaf values. To change one key inside a block without losing its siblings, name that key directly (`--set voice.voice_id=onyx`) rather than replacing the block (`--set voice='{"voice_id":"onyx"}'`, which would drop `provider`).

### Delete

```console
node index.js delete <id> --yes
```

`--yes` is mandatory. Deletion cannot be undone. Bots already running with the config keep their attached agent until they leave the meeting.

## Options

| Option | Applies to | Meaning |
| --- | --- | --- |
| `--preset <name>` | create | Start from `pipeline`, `realtime`, or `wake-word` |
| `--file <path>` | create, update | JSON object merged into the body |
| `--name <text>` | create, update | Sets `agent_name` |
| `--model <id>` | create, update | Sets `model.model` |
| `--prompt <text>` | create, update | Sets `model.system_prompt` |
| `--set <path=value>` | create, update | Any field, dotted path, repeatable. Values parse as JSON when possible |
| `--dry-run` | create, update | Print the request body and exit |
| `--yes` | delete | Confirm the deletion |
| `--json` | all | Print the raw API response |

## Agent config shape

Pipeline mode chains three swappable layers. Realtime mode replaces all three with one speech-to-speech model, so it has no separate `voice`, `transcriber`, or `wake_word` block.

```json
{
  "agent_name": "Pipeline Voice Assistant",
  "mode": "pipeline",
  "model": { "provider": "openai", "model": "gpt-4.1", "system_prompt": "..." },
  "voice": { "provider": "openai", "voice_id": "nova" },
  "transcriber": { "provider": "deepgram", "model": "nova-3", "language": "en" },
  "agent": { "response_type": "voice", "first_message": "...", "mcp_servers": [] },
  "wake_word": { "enabled": true, "words": ["hey acme"], "timeout": 30 }
}
```

| Block | Pipeline | Realtime |
| --- | --- | --- |
| `model` | text model | speech-to-speech model, carries its own `voice` |
| `voice` | required | not used |
| `transcriber` | required | not used |
| `wake_word` | supported | not used |
| `agent.response_type` | `voice`, `chat`, or `action` | `voice`, `chat`, or `action` |

The `GET` routes return these blocks with PascalCase keys (`Model`, `Voice`, `Transcriber`, `Agent`, `WakeWord`). The CLI reads both casings, so `--json` output may differ in shape from what you sent.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `MEETSTREAM_API_KEY is missing from .env` | No `.env`, an empty key, or the `your_..._here` placeholder. | Copy `.env.example` to `.env` and paste a real key. |
| HTTP 401 | No key reached the API. | Check `.env` is loaded from the directory you ran `node` in. |
| HTTP 403 | The key is wrong or revoked. | The auth header must be `Authorization: Token <key>`, not `Bearer`; regenerate the key. |
| HTTP 404 on get, update, or delete | The id does not exist. | Run `list` to see valid ids. |
| HTTP 400 on create or update | A provider, model id, or voice id is not available to your account, or a required block is missing for the mode. | Re-run with `--dry-run` and compare against the table above. |
| `--set` produced the wrong shape | Values are parsed as JSON first and fall back to a plain string. | Quote arrays and objects for your shell: `--set wake_word.words='["hey acme"]'`. |
| HTTP 507 | An idempotent replay: the original request already succeeded, so the agent exists. | Run `list` to find it. |
| `Unknown option --x` | A flag the CLI does not know. | `node index.js --help` lists every option. |

## Related

- [What is MIA](https://docs.meetstream.ai/guides/mia/what-is-mia)
- [Create an agent](https://docs.meetstream.ai/guides/mia/create-an-agent)
- [MIA API guide](https://docs.meetstream.ai/guides/mia/mia-api-guide)
- [MIA custom configurations](https://docs.meetstream.ai/guides/mia/mia-custom-configurations)
- [Create agent config](https://docs.meetstream.ai/api-reference/api-endpoints/mia/create-agent-config)
- [Get agent configs](https://docs.meetstream.ai/api-reference/api-endpoints/mia/get-agent-configs)
- [Update agent config](https://docs.meetstream.ai/api-reference/api-endpoints/mia/update-agent-config)
- [Delete agent config](https://docs.meetstream.ai/api-reference/api-endpoints/mia/delete-agent-config)
- Sibling templates: [mia-voice-agent-pipeline](../mia-voice-agent-pipeline), [mia-realtime-agent](../mia-realtime-agent), [mia-wake-word-assistant](../mia-wake-word-assistant), [MIA-chat-agent](../MIA-chat-agent)
