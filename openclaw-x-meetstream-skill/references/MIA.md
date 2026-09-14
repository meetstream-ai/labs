# Create and run a hosted MIA agent

Verified 2026-09-11. MIA is MeetStream's hosted conversational agent runtime;
OpenClaw can configure and dispatch it but does not supply its speech pipeline.
Read the live [MIA API guide](https://docs.meetstream.ai/guides/mia/mia-api-guide)
for provider-dependent fields; newer fields are not all in OpenAPI.

## Create an agent

In dashboard Integrations, add the required provider API keys. Open MIA →
Create New Agent. Choose realtime for a single speech-to-speech provider, or
pipeline for independent model, voice and transcriber providers. Choose audio,
chat, or action response modality, write a system prompt, configure tools if
needed, and save. An Anam avatar is optional: add its integration key and use
an avatar_id (not persona_id). Pipeline wake-word gating defaults on; explicitly
configure it or disable it for always-on interaction. Speaker-aware responses
are also pipeline-only. Dashboard creation is sufficient for OpenClaw to use
list-agents and send-bot with the returned AgentConfigID.
Source: [agent walkthrough](https://docs.meetstream.ai/guides/mia/create-an-agent).

An illustrative minimal pipeline payload (store as `agent.json`):

```json
{
  "agent_name": "Meeting Assistant",
  "mode": "pipeline",
  "model": {
    "provider": "openai",
    "model": "gpt-4.1",
    "system_prompt": "Help participants summarize decisions when asked."
  },
  "voice": {"provider": "openai", "voice_id": "nova"},
  "transcriber": {"provider": "deepgram", "model": "nova-3"},
  "wake_word": {"enabled": false}
}
```

```bash
scripts/api-request.sh POST /mia --body-file agent.json
scripts/list-agents.sh
scripts/send-bot.sh --link '<actual-meeting-url>' --name 'Meeting Assistant' --agent-id '<AgentConfigID>'
```

POST/GET/PUT/DELETE `/mia` manage configurations; inspect the endpoint schema
for each operation's ID parameter. Hosted dispatch needs only agent_config_id;
MeetStream supplies WebSocket connections. agent_config_params fills stored
prompt variables. POST `/bots/{id}/update_mia` updates an active session's
system_prompt, parameters, wake_word_enabled or wake_words; acceptance is
asynchronous. Live wake overrides don't persist across runtime replacement.
For permanent changes update the saved configuration too.
Source: [MIA API](https://docs.meetstream.ai/guides/mia/mia-api-guide).

## Models and behavior

Realtime supports OpenAI, xAI and Google; pipeline supports independent LLM,
TTS and STT providers. Use current dashboard options/guide values rather than
assuming every provider-native model is accepted. Voice IDs must belong to
the selected provider. Tune VAD, interruption policy, endpointing, audio
sample rate, response modality and greeting for the meeting. Pipeline wake
words use a rolling listening window, with optional participant-count bypass
and a maximum session window. MIA STT models are separate from recording
transcription models (e.g. don't apply the recording AssemblyAI model enum to
an agent's transcriber).
Source: [MIA capabilities](https://docs.meetstream.ai/guides/mia/what-is-mia).

## External tools

Use MCP servers for multi-tool integrations, custom functions for individual
HTTPS endpoints. MCP entries configure url, headers, allowed_tools and timeout.
The dashboard can fetch available tools. A locally hosted MCP needs a public
HTTPS tunnel; the Docker gateway example uses streaming transport on port
8080 and the tunnel URL plus `/mcp`. This connects tools to hosted MIA; it
does not connect OpenClaw's local filesystem automatically.
Source: [agent tool setup](https://docs.meetstream.ai/guides/mia/create-an-agent).

Custom functions define a unique name, description, public HTTPS URL, method,
JSON-schema parameters, and narrowly scoped auth headers. Default request
body is `{name,bot,args}`; payload_args_only flattens it to args. X-Bot-ID is
reliable; X-Agent-ID is optional. GET/DELETE have no body by default. Configure
timeout_s, retries and response_cap_chars; writes must tolerate retries.
Response variables use object dot paths (no arrays) and feed later templates;
they override matching initial variables during a saved-prompt rebuild.
Literal live system_prompt text is not template-expanded. Use
speak_during_execution for filler and speak_after_execution=false for silent
completion. `env:VAR` works only as an entire header value and only for a
variable provisioned in MeetStream's runtime, not OpenClaw's environment.
Function headers can be returned by configuration reads: do not expose them.
Source: [custom functions](https://docs.meetstream.ai/guides/mia/mia-custom-configurations).
