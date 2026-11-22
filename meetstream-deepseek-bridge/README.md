# MeetStream × DeepSeek Harness

A community bridge that brings a DeepSeek Harness agent into Google Meet, Zoom and Microsoft Teams through MeetStream. Participants can ask repository questions, propose engineering tasks, and receive answers through voice and meeting chat. A local operator approves each engineering task before execution.

This integration is independent of DeepSeek and pins Harness **0.2.1-rc.5**. For guided setup without technical configuration, follow [Quickstart.md](Quickstart.md).

## Prerequisites

- Node.js **24.9 or newer** and Git.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **0.2.1-rc.5**, installed separately with `npm install -g @deepseek-ai/dsh@0.2.1-rc.5`, or the matching official macOS app. The app's bundled CLI is detected automatically.
- A funded [DeepSeek API key](https://platform.deepseek.com/) with access to the configured model. A browser login does not supply API credentials.
- A [MeetStream API key](https://app.meetstream.ai/api-key) with MIA access. Connect **Google Gemini** under MeetStream's model integrations and **Deepgram** under transcription integrations. These services need their own working API access and billing configuration.
- The [ngrok CLI](https://ngrok.com/download) and an authtoken, or an externally managed HTTPS connection.
- A disposable Git checkout of the repository to investigate, without secrets or unrelated changes.
- A meeting host who can admit the bot and enable chat, recording and transcription as required by the platform.

## Run

Clone or download MeetStream Labs, open a terminal in `labs/meetstream-deepseek-bridge`, and run:

```sh
npm start
```

The launcher installs missing bridge dependencies and privately prompts for the DeepSeek key, MeetStream key, target repository path, meeting link and ngrok authtoken. It saves settings in `.env` with mode `0600`; a prompted meeting link is used only for the current run.

Startup checks the exact Harness version and makes a small read-only provider request, bounded to 60 seconds, before creating any MIA configuration or bot. This request uses the configured provider's API and can incur usage. After **“Admit DeepSeek Meeting Agent”** appears, admit the bot and leave the terminal open.

### Manual configuration

For scripted or advanced setup:

```sh
cp .env.example .env
chmod 600 .env
```

Edit `.env` privately. Set at least `DEEPSEEK_API_KEY`, `MEETSTREAM_API_KEY` and `REPO_PATH`; supply the meeting link at startup or set `MEETING_URL`.

| Setting | Purpose |
|---|---|
| `DEEPSEEK_API_KEY` | API-key authentication. The default route is `deepseek-official` with model `deepseek-flash`. |
| `REPO_PATH` | Absolute path to the disposable Git checkout. |
| `MEETSTREAM_API_KEY` | MeetStream workspace credential with MIA access. |
| `MEETING_URL` | Optional meeting invitation link; prompted when missing. |
| `NGROK_AUTHTOKEN` | Credential for the bridge's managed tunnel. |
| `PUBLIC_URL` | Optional HTTPS origin forwarding to the bridge. Leave blank to manage ngrok automatically. |
| `PORT` | Loopback HTTP port; defaults to `8787`. |
| `DSH_BIN` | Optional path to the pinned Harness executable. |
| `TASK_TIMEOUT_MS` | Task deadline; defaults to `900000` milliseconds (15 minutes). |
| `MIA_PROVIDER`, `MIA_MODEL`, `MIA_VOICE` | Voice configuration; defaults are supplied in `.env.example`. |
| `DSH_ACCOUNT` | Explicit macOS Harness account mode; defaults to `false`. |

API-key mode overrides the saved Harness provider selection. Account mode uses the installed official credential plugins and has no API-key fallback. Choose one authentication mode deliberately.

An externally managed `PUBLIC_URL` must forward to `127.0.0.1:PORT`. Exclude `/admin/*` at your reverse proxy where possible; admin routes also require a separate operator token. The bridge stops only tunnels it starts itself. MIA retains its internally provisioned speech connection; do not override it with an external control socket.

Check the installation or provider independently:

```sh
npm run doctor
npm run doctor -- --probe
```

The probe makes a real inference request through the configured provider. To supply a meeting link explicitly:

```sh
npm start -- --meeting 'https://meet.google.com/xxx-xxxx-xxx'
```

## Questions, approval and cancellation

Say **“DeepSeek, ask the repository where the parser is implemented.”** Repository questions use a read-only Harness session. Speaker-labelled final transcripts provide bounded context; transcript events alone do not launch tasks.

For engineering work, say **“DeepSeek, propose fixing the empty-input parser bug and running its tests.”** The proposal stays `awaiting_approval` until the operator reviews and approves it. In a second terminal in this project folder:

```sh
npm start -- status
npm start -- approve
# Alternatively, approve an exact previously reviewed reference:
npm start -- approve SESSION_ID TASK_ID
```

The interactive command displays saved proposals and asks which one to approve. Spoken agreement alone cannot authorize changes, and MIA's credential cannot call the approval route. Approved engineering work uses a separate workspace-write Harness session.

Fast answers can return within the 20-second tool wait for MIA to speak. Longer tasks keep their references and send progress and results through MeetStream's chat API. Ask for a task's status or result to hear it aloud. Automatic background voice announcements are not implemented. Large tool results are marked when truncated; the retained result remains available through local status.

Say **“DeepSeek, cancel task [reference].”** Cancellation waits for runtime termination and suppresses late results. It does not undo edits or external effects already performed. Review changed files and run repository tests before using the result.

GitHub publication remains an operator action: review the diff, tests and selected files before committing, pushing or opening a draft PR. Publishing credentials are excluded from the Harness subprocess environment. An externally created PR is not automatically attached to an already completed task.

## Stop and recover

Press **Ctrl+C** in the launcher terminal, or run from another terminal in this folder:

```sh
npm stop
```

Wait for confirmation. Shutdown works during setup and active tasks: it cancels pending work, terminates the owned runtime, confirms bot departure, deletes its MIA configuration and closes the managed tunnel. Repeated stop commands are safe, including before the first start. `npm stop` controls the bridge; stop separately launched tests with Ctrl+C in their own terminal.

If connectivity or service errors prevent cleanup, keep `.state` and `.env`, restore access, and run `npm stop` again. A new launch reconciles pending owned resources before creating another bot. Running or queued tasks left by a crash become `interrupted` and are never replayed automatically.

If a create request times out before its returned ID is saved, ownership is ambiguous and startup blocks automatic recreation. Locate the configuration named `DeepSeek bridge SESSION_ID` and bots tagged with `custom_attributes.deepseek_bridge_session=SESSION_ID` in MeetStream. Confirm removal of only those resources and reconcile the private ledger before restarting. Deleting `.state` is not a cleanup method.

## State and security

MIA custom functions and final-transcript callbacks reach the loopback HTTP service through HTTPS. The bridge records meeting/session mapping, task references, results and delivery receipts in SQLite under `.state`, then runs Harness in the configured repository.

- A durable receipt binds each request ID to its session, kind and effective text. An identical retry returns the existing task; conflicting reuse fails. Different request IDs can create separate proposals, each requiring approval.
- A single execution slot serializes work per meeting and repository. Each meeting retains separate Harness sessions for read-only questions and approved writes.
- MIA calls require a random bearer capability and matching bot/session identity. Local admin routes use a separate credential stored in `.state/active.json`. Transcript speaker labels are context, not authentication.
- Runtime cancellation sends SIGTERM, escalating to SIGKILL after two seconds. An IPC supervisor also kills the owned runtime group if the bridge disappears.
- Chat API acceptance is tracked separately from visible delivery. Ambiguous sends are not replayed automatically; results remain in the ledger.
- Keep `.env`, `.state`, callback URLs and Harness session history private. The bridge requests 48-hour MeetStream media retention; stopping does not erase recordings or local history.

Harness sandbox enforcement depends on the installed runtime and OS. Use a disposable checkout; trusted installation plugins and profiles still affect execution. Shared-ledger multi-replica operation is unsupported.

## Meeting platforms

The setup guide targets macOS. Automated bridge checks run on macOS and Linux; the actual sandbox contract is qualified on macOS. Linux sandbox acceptance remains pending, and Windows full-process-tree cancellation is outside this release's supported scope.

| Platform | Required setup |
|---|---|
| Google Meet | Host admission, enabled chat, working microphone and configured MeetStream providers. |
| Zoom | MeetStream Zoom account/Marketplace setup, supported invitation URL, host admission and recording permission. |
| Microsoft Teams | Supported invitation URL, organization bot/access policy, admission and chat permissions. |

Platform availability comes from MeetStream; validate your host and organization settings using its [platform FAQ](https://docs.meetstream.ai/guides/help/faq). In your meeting, check spoken and chat answers, speaker attribution, an approved task, cancellation and departure before relying on the workflow.

## Development checks

```sh
npm ci
npm run check
npm run format:check
npm test
npm run test:api-key
npm run test:sandbox
npm run demo
npm audit --audit-level=high
```

`npm test` covers authentication, session binding, receipts, exact approval, queues, cancellation, restart fencing, output limits and launcher cleanup. `test:api-key` drives the pinned Harness against deterministic DeepSeek Messages responses, including real tool edits, independent regression checks, session resume, REST chat and the npm lifecycle. `test:sandbox` checks actual Bash and file-write permissions. These checks use controlled API fixtures; the demo uses a fixture agent and simulated meeting chat. Startup and the doctor probe check the user's configured provider separately.

MeetStream's [MIA guide](https://docs.meetstream.ai/guides/mia/mia-api-guide) documents the hosted voice and custom-function API. The [Universal Agent Adapter](https://github.com/meetstream-ai/universal-agent-adapter) informed the meeting integration; the bridge uses the pinned [Harness runtime](https://github.com/deepseek-ai/deepseek-harness) for repository execution.

MIT licensed. See [LICENSE](LICENSE).
