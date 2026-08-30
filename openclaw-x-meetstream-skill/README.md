# MeetStream for OpenClaw

An OpenClaw skill for operating the [MeetStream](https://meetstream.ai)
meeting-bot API with natural language. For the shortest installation path,
see [QUICKSTART.md](./QUICKSTART.md). This file is the technical reference;
for a narrative walkthrough, see [blog.md](./blog.md).

## Install in one sentence

- **macOS:** double-click `setup-macos.command`.
- **Windows:** install WSL2 and OpenClaw in Ubuntu, then double-click
  `setup-windows.cmd`.

The installer securely asks for your MeetStream API key, installs the skill,
runs tests, restarts the Gateway, and checks the live connection.

## What OpenClaw is

OpenClaw is the local agent runtime that receives your chat request, chooses
an appropriate skill, and runs the tools allowed for that agent. Its
**Gateway** is the background service that connects the app/CLI, agent,
workspace, skills, and model provider. A workspace skill is a folder under
`<workspace>/skills/` with a `SKILL.md` file.

This project is a small skill suite. The root `meetstream` skill handles daily
operations, while focused nested skills guide bot building, notetaking,
debugging, and calendar scheduling. It does not replace OpenClaw, provide an AI
model, or run its own chat interface. OpenClaw reads this skill's `SKILL.md`,
maps requests such as “show my MIA agents” to the scripts in `scripts/`, and
those scripts make authenticated requests to MeetStream. You therefore need:

1. OpenClaw installed, onboarded with a model provider, and its Gateway
   running;
2. a MeetStream account and API key; and
3. this folder installed as `<workspace>/skills/meetstream`.

## Setup choices

There are two supported paths: [macOS](./QUICKSTART.md#macos) and
[Windows with WSL2](./QUICKSTART.md#windows). Both use the same installer and
leave the skill in OpenClaw's configured workspace. VS Code is optional; if you
use it, run the installer from its macOS or WSL terminal.

## Official guides

- [OpenClaw installation](https://docs.openclaw.ai/install) and
  [Windows/WSL2 setup](https://docs.openclaw.ai/windows)
- [MeetStream API overview](https://docs.meetstream.ai/api-reference/introduction)
- [Create your first meeting bot](https://docs.meetstream.ai/guides/get-started/create-your-first-bot)
- [Post-call transcription](https://docs.meetstream.ai/guides/transcription-recordings/post-call-transcription)

## Contents

- [What OpenClaw is](#what-openclaw-is)
- [Setup choices](#setup-choices)
- [Architecture](#architecture)
- [Request flow](#request-flow)
- [Component reference](#component-reference)
- [Operation sequences](#operation-sequences)
- [Configuration reference](#configuration-reference)
- [Error handling model](#error-handling-model)
- [Testing architecture](#testing-architecture)
- [Security model](#security-model)
- [Extending the skill](#extending-the-skill)
- [Troubleshooting](#troubleshooting)
- [Publishing](#publishing)

## Architecture

```
┌─────────────┐   natural language    ┌──────────────────┐
│    User     │ ─────────────────────▶│  OpenClaw agent   │
└─────────────┘                       │  (reads SKILL.md) │
                                       └─────────┬─────────┘
                                                 │ shells out
                                                 ▼
                                       ┌──────────────────┐
                                       │  scripts/*.sh      │
                                       │  (this skill)       │
                                       └─────────┬─────────┘
                                                 │ curl + jq
                                                 ▼
                                       ┌──────────────────┐
                                       │ MeetStream REST API │
                                       │ api.meetstream.ai   │
                                       └──────────────────┘
```

Nothing in this skill talks to MeetStream except the shell scripts in
`scripts/`. `SKILL.md` contains no logic of its own — it's a natural-language
spec telling the OpenClaw agent *which script to run, when, and how to
interpret ambiguity*. The agent is the only thing that ever decides "the
user means send-bot.sh with these args"; the scripts themselves are dumb,
deterministic, and independently testable.

This split matters for review: the attack surface for "can the agent be
tricked into doing something dangerous" lives in `SKILL.md`'s instructions,
while the attack surface for "can a malformed input break the HTTP request"
lives entirely in `scripts/`, which you can audit and test without an LLM
in the loop at all.

## Request flow

1. **User says something** to the agent, e.g. "send my standup bot to
   `https://meet.google.com/abc-defg-hij`".
2. **OpenClaw loads `SKILL.md`** (gated by `metadata.openclaw.requires` for
   `curl` and `jq`). `primaryEnv` identifies `MEETSTREAM_API_KEY` for
   OpenClaw's `skills.entries.meetstream.apiKey` secret integration, while
   the scripts also support the installer's local mode-0600 `.env` fallback.
3. **The agent maps intent → script + args.** For "send my standup bot",
   that's `scripts/send-bot.sh --link <url> --name "Standup Bot" --agent-name standup`.
   `SKILL.md` explicitly tells the agent not to fabricate a meeting link —
   it must come from the user's message or conversation context.
4. **The script runs**, sourcing `scripts/lib.sh` for shared HTTP/auth
   logic, and making one or more calls to `api.meetstream.ai/api/v1`.
5. **The script prints a human-readable summary to stdout** (or raw JSON
   with `--json`) and exits 0, or prints an error to stderr and exits
   non-zero.
6. **The agent relays the result** back to the user, per `SKILL.md`'s
   output conventions (surface real errors, don't retry silently, keep the
   returned `bot_id` in context for follow-up turns).

## Component reference

### `scripts/lib.sh` (shared, not directly invoked)

Sourced by every other script. Provides:

| Function | Purpose |
|---|---|
| `ms_check_deps` | Verifies `curl` and `jq` are on `PATH`; exits 127 if not. |
| `ms_require_api_key` | Exits 78 (`EX_CONFIG`) with setup instructions if `MEETSTREAM_API_KEY` is unset. |
| `ms_request METHOD PATH [BODY]` | Core HTTP wrapper. Adds `Authorization: Token <key>` header, sends `BODY` as JSON if present, captures HTTP status separately from body via `curl -w '%{http_code}'`, and on non-2xx responses prints the parsed error detail to stderr and returns non-zero — callers never see a raw, unparsed failure. |
| `ms_get` / `ms_post` | Thin wrappers over `ms_request`. |
| `ms_urlencode` | Percent-encodes query parameter values via `jq -rn --arg s "$s" '$s\|@uri'`. |

Also handles **safe `.env` loading**: if `MEETSTREAM_API_KEY` isn't already in
the environment and `MEETSTREAM_SKIP_DOTENV` isn't set, it parses exactly one
`MEETSTREAM_API_KEY=...` assignment from `<skill_root>/.env` as literal data.
It never sources or executes the file. Symlinks, duplicate assignments,
unknown entries, and empty values fail closed. An explicitly exported env var
always wins.

The production base URL is pinned to `https://api.meetstream.ai/api/v1` so the
Authorization token cannot be redirected. The offline suite may select an
HTTP loopback mock only when `MEETSTREAM_TEST_MODE=1` is also set.

### `scripts/list-agents.sh`

`GET /mia` → prints each MIA agent's `AgentName`, `AgentConfigID`, `Mode`
(`realtime`/`pipeline`), and model. `--json` for raw output.

### `scripts/send-bot.sh`

`POST /bots/create_bot`. Required: `--link`, `--name`. The interesting logic
is `--agent-name` resolution: it calls `GET /mia`, filters
`AgentName` case-insensitively by substring match, and:
- 0 matches → error, suggests `list-agents.sh`
- 1 match → resolves to that `AgentConfigID` and proceeds
- 2+ matches → refuses to guess, prints all candidates, exits 1

This same "refuse on ambiguity, don't pick one" pattern is used again in
`remove-bot.sh --current` (see below) — it's the skill's central safety
property for any action with real-world side effects.

When a MIA `agent_config_id` is selected, the payload also includes
MeetStream's documented agent bridge and live-audio WebSocket endpoints, so
the agent is actually connected when the bot joins.

Request body is assembled with `jq -n --arg`/`--argjson`, never string
interpolation, so meeting links, bot names, chat messages, and
`--attr KEY=VALUE` custom attributes can't break out of the JSON structure
no matter what characters they contain.

### `scripts/list-bots.sh`

`GET /bots`, with optional `--status`/`--platform`/`--from`/`--to` query
filters (URL-encoded via `ms_urlencode`). The `--active` flag is a
**client-side, best-effort** filter: it excludes any bot whose `status`
string matches `done|stop|left|error|fail|expired|not.?allowed|removed`
(case-insensitive). This is heuristic on purpose — MeetStream's status
vocabulary isn't guaranteed stable, so `--active` is a shortlist to narrow
down candidates, not a source of truth. Scripts and `SKILL.md` both treat a
multi-match `--active` result as "ask the user," never "pick the first one."

### `scripts/bot-status.sh`

`GET /bots/:id/status`. Single lookup, no filtering logic.

### `scripts/remove-bot.sh`

`GET /bots/:id/remove_bot`. Takes either an explicit `bot_id` or `--current`,
which internally calls `list-bots.sh --active --json` and:
- 0 active bots → error, nothing to remove
- 1 active bot → resolves and removes it
- 2+ active bots → refuses, prints candidates, exits 1 (same pattern as
  `send-bot.sh --agent-name`)

### `scripts/doctor.sh`

Standalone health check, run manually or by `install.sh`. Checks, in order,
independent of each other (one failing doesn't block the rest from
running): `curl` present → `jq` present → `MEETSTREAM_API_KEY` set → a live
`GET /mia` call to confirm the key actually authenticates → whether
`openclaw skills list` (if the CLI is on `PATH`) reports this skill as
discovered. Supports `--json` for machine-readable output. Exits 0 only if
every check passed.

Implementation note: since it sources `lib.sh` (which sets `-e`) but needs
to keep checking after an individual step fails, it explicitly runs
`set +e` immediately after the `source` call.

### `install.sh`

Orchestrates first-time setup:

1. Resolve the OpenClaw workspace path (`openclaw config get agents.defaults.workspace`,
   falling back to `~/.openclaw/workspace` if the CLI isn't available or the
   config key is empty, or `--workspace` if passed explicitly).
2. Copy skill files into `<workspace>/skills/meetstream`, or update in
   place (preserving any existing `.env`) if already installed there.
3. Check for `curl`/`jq`; install via Homebrew if missing and Homebrew is
   available, otherwise print manual install instructions.
4. Resolve the API key from (in priority order): safe `--api-key-stdin`, an
   already-existing `.env`, the caller's exported
   `MEETSTREAM_API_KEY`, or an interactive hidden prompt. The installer
   rejects symlinked credential files and writes them atomically as mode 0600.
5. Run `tests/run_tests.sh` against the installed copy.
6. Restart the OpenClaw gateway (`openclaw gateway restart`), unless
   `--no-restart`.
7. Run `scripts/doctor.sh` and exit with its status code.

## Operation sequences

**"send my standup bot to `<url>`"**
```
agent → send-bot.sh --link <url> --name "Standup Bot" --agent-name standup
          → GET /mia                         (resolve agent name → id)
          → POST /bots/create_bot             (join, with agent_config_id + MIA bridge URLs)
        → bot_id printed, agent reports it back to user
```

**"remove the bot from the current call"**
```
agent → remove-bot.sh --current
          → list-bots.sh --active --json      (GET /bots, client-side filter)
          → [if exactly one candidate and no later page] GET /bots/:id/remove_bot
          → [if 0 or 2+] exit 1, print candidates — agent asks user instead of guessing
```

## Configuration reference

| Variable | Required | Default | Set via |
|---|---|---|---|
| `MEETSTREAM_API_KEY` | yes | — | `.env` (auto-loaded), shell export, or OpenClaw's `skills.entries.meetstream.env` config |
| `MEETSTREAM_API_BASE` | no | `https://api.meetstream.ai/api/v1` | production is pinned; tests may use an HTTP loopback URL with `MEETSTREAM_TEST_MODE=1` |
| `MEETSTREAM_SKIP_DOTENV` | no | unset | shell export — set to any value to force-skip `.env` auto-load |
| `MEETSTREAM_TEST_MODE` | no | unset | tests only; permits an HTTP loopback API base and must never be used with a production key |

## Error handling model

Scripts follow a consistent exit-code convention so a calling agent (or CI)
can branch on failure type without parsing stderr text:

| Exit code | Meaning |
|---|---|
| `0` | Success |
| `1` | Runtime failure — API error, network error, ambiguous match refused, unknown resource |
| `64` (`EX_USAGE`) | Bad arguments — missing required flag, malformed value, conflicting flags |
| `78` (`EX_CONFIG`) | Missing configuration — `MEETSTREAM_API_KEY` not set |
| `127` | Missing dependency — `curl` or `jq` not on `PATH` |

Every non-2xx API response is parsed for `.detail`/`.message`/`.error` (in
that priority order) via `ms_request` before being surfaced, so failures
read as MeetStream's actual error text, not a raw curl exit or an unparsed
JSON blob.

## Testing architecture

`tests/mock_server.py` is a dependency-free Python `http.server` that
reproduces the request/response shapes of the endpoints this
skill calls (including stateful behavior — e.g. `remove_bot` actually
flips a mock bot's status to `Stopped`, so a subsequent `--active` list
reflects it). It is included for review and installer self-tests, but it is
not loaded into the agent prompt; OpenClaw loads `SKILL.md` and the agent
invokes only the documented `scripts/` entry points.

`tests/run_tests.sh`:
1. Starts the mock server on an ephemeral `127.0.0.1` port, points
   `MEETSTREAM_API_BASE` at it, and enables explicit test mode.
2. Runs the "no API key" guard test with `MEETSTREAM_SKIP_DOTENV=1` so it's
   deterministic even if this copy of the skill has a real `.env` installed.
3. Exercises all operation scripts' happy paths, `--json` output, malformed-input
   rejection, ambiguous-match refusal (both `send-bot.sh --agent-name` and
   `remove-bot.sh --current`), and API-level error propagation (401 from a
   bad key, 404 for an unknown bot ID).
4. Asserts on both exit code and output content for each case; prints a
   pass/fail tally and exits non-zero if anything failed.

`shellcheck -x install.sh scripts/*.sh tests/run_tests.sh` is expected to be clean; CI
(`.github/workflows/ci.yml`) runs both shellcheck and the test suite on
every push and PR.

## Security model

- **Credential handling**: key is read from env/`.env` only, sent once per
  request as an `Authorization: Token …` header, never logged or written
  anywhere by any script.
- **No silent destructive actions**: `send-bot.sh` (joins a meeting — a
  real, visible action) and `remove-bot.sh` (ends a bot's participation)
  both require unambiguous input, and refuse to guess when more than one
  candidate could match.
- **Injection safety**: all user-controlled values are passed through
  `jq -n --arg`, never string-interpolated into a shell command or JSON
  body.
- **Fixed egress**: production requests are pinned to
  `https://api.meetstream.ai/api/v1`; only explicit test mode permits an HTTP
  loopback mock. No script fetches or executes remote code.
- **Scope**: a MeetStream API key can join/list/remove bots and read/write
  MIA agent configs for its account — nothing outside MeetStream's API
  surface, and no OpenClaw-host access beyond what these scripts request.

## Extending the skill

To add a new MeetStream endpoint:

1. Add a function or new script in `scripts/`, sourcing `lib.sh` and using
   `ms_get`/`ms_post` (extend `lib.sh` with `ms_request PATCH/DELETE` if a
   new HTTP verb is needed — the wrapper is verb-agnostic already).
2. Follow the existing exit-code convention (64/78/127/1/0).
3. Add a route + fixture data to `tests/mock_server.py`, and corresponding
   assertions to `tests/run_tests.sh`.
4. Document the new command in `SKILL.md` under **Commands**, including
   when the agent should call it and any ambiguity-handling rules.
5. Run `shellcheck -x scripts/*.sh` and `bash tests/run_tests.sh` before
   committing.

## Troubleshooting

Run `scripts/doctor.sh` first — it isolates which layer is broken. Beyond
that:

| Symptom | Likely cause |
|---|---|
| `openclaw skills list` doesn't show `meetstream` | Copied to the wrong workspace path, or gateway needs a restart (`openclaw gateway restart`) |
| `error: MEETSTREAM_API_KEY is not set` despite `.env` existing | `.env` isn't in the skill's root directory (must sit next to `SKILL.md`, not inside `scripts/`) |
| `MeetStream API returned HTTP 401/403` | Bad or revoked key — regenerate at <https://app.meetstream.ai/api-key> |
| `send-bot.sh` / `remove-bot.sh` refuses with "matches more than one" | Expected safety behavior — re-run with an explicit `--agent-id` / `bot_id` |
| Tests fail only after running `install.sh` | Should not happen (isolated via `MEETSTREAM_SKIP_DOTENV`) — if it does, check you're on a version with that fix |

## Publishing

ClawHub publishes skills under MIT-0. This repository uses that license and
its `SKILL.md` metadata matches the current native skill format. Preview the
exact bundle before publishing:

```bash
clawhub login
clawhub skill publish . --slug meetstream --name "MeetStream" --dry-run
clawhub skill publish . --slug meetstream --name "MeetStream"
```

Once published, installation for end users collapses to
`openclaw skills install @owner/meetstream` — no manual file copying at all.
Replace `owner` with the ClawHub publisher handle. An
authenticated publisher still needs to choose the owner and complete
ClawHub's automated security review; this project does not publish itself.
