# Quickstart: bring DeepSeek into your meeting

This project puts an assistant in your meeting. You can ask it about a code repository, approve a coding task, and hear or read the result. You control it from your computer.

This is a community project using DeepSeek Harness for repository work and MeetStream MIA for meeting voice. Startup checks your configured model access before inviting the assistant.

## 1. Install these tools once

This guide uses Terminal on a Mac. A technical teammate can help with these one-time steps:

- Install [Node.js](https://nodejs.org/) **24.9 or newer**, which includes the `npm` command.
- Install [Git](https://git-scm.com/downloads).
- Install [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), exactly **0.2.1-rc.5**. A matching official Mac app is detected automatically. If using the command-line version, run `npm install -g @deepseek-ai/dsh@0.2.1-rc.5` once. This runtime is maintained upstream and installed separately from the bridge.
- Install the official [ngrok command-line tool](https://ngrok.com/download). The bridge starts and stops its own ngrok connection for you.

Reopen Terminal after installing. Keep your computer awake and connected during the meeting. Windows process-tree cleanup is outside this release's supported scope; validate platform-specific meeting permissions before deployment.

## 2. Have your accounts ready

An API key is a private code that lets the project use a service on your behalf.

| What you need | Where it is used |
|---|---|
| A [DeepSeek API key](https://platform.deepseek.com/) with API usage and model access enabled | Lets Harness investigate and edit the repository. Use the programmatic API key rather than a browser login. |
| A [MeetStream API key](https://app.meetstream.ai/api-key) with MIA access | Invites and controls the meeting assistant. |
| An [ngrok authtoken](https://dashboard.ngrok.com/get-started/your-authtoken) | Lets MeetStream reach the project on your computer. |

In your **MeetStream dashboard → Integrations**, also connect **Google Gemini** for the assistant's voice and **Deepgram** for live transcription. Each service needs its own working API access and billing configuration. These integrations stay in MeetStream, so the launcher does not ask you to paste their keys locally.

Have a separate Git copy of the repository you want the assistant to work on. Use that copy's folder path when asked. A ZIP without Git history is not sufficient; ask a teammate to prepare a disposable Git checkout if needed.

## 3. Open this project and start

On the MeetStream Labs GitHub page, choose **Code → Download ZIP**, or ask a teammate to clone it. Extract the ZIP if needed and find the **meetstream-deepseek-bridge** folder inside it. Open **Terminal**, type `cd `, drag that bridge folder from Finder into Terminal, then press Enter. Run subsequent commands from that folder.

Create or open a meeting and copy its invitation link. You must be able to admit the assistant and allow meeting chat and transcription.

Run:

```sh
npm start
```

The first run installs the bridge's dependencies automatically. It then asks for anything missing:

1. Your DeepSeek API key.
2. Your MeetStream API key.
3. The folder path of the separate Git repository copy.
4. Your meeting invitation link.
5. Your ngrok authtoken, unless a public connection is already configured.

Keys are hidden while you type or paste them. Press Enter after each answer. Saved settings go into a private `.env` file; you do not need to create or edit it yourself. The prompted meeting link is used for this run, so a later start asks for the next meeting.

Startup makes a small, read-only model request to check access. This is an API request billed under your configured provider. Invalid credentials, insufficient balance, a missing repository or a failed connection stop startup before a meeting bot is invited. No coding task runs during this check.

When Terminal says **“Admit DeepSeek Meeting Agent”**, admit that participant in your meeting. Leave Terminal open. On Zoom, the host may also need to allow recording; Zoom requires additional account setup. See [platform notes](README.md#meeting-platforms).

You do not need to launch the bot separately in MeetStream. Running `npm start` while this bridge is already running will refuse a second owner rather than invite a duplicate bot.

## 4. Ask a question or approve a task

Start with:

> DeepSeek, ask the repository where the parser is implemented.

Use a quiet microphone and wait for the answer. The assistant can reply aloud and post results in meeting chat. If a longer task is still running, ask:

> DeepSeek, what is the result of that task?

To request engineering work, say:

> DeepSeek, propose fixing the empty-input parser bug and running its tests.

The assistant proposes the work and waits. To approve it, open a **second Terminal window in this same bridge folder** and run:

```sh
npm start -- approve
```

Read the displayed request carefully. Enter the number of the task you want to approve, or press Enter to leave it unapproved. This command approves the selected saved task; it does not invite another bot. Saying “yes” in the meeting alone does not authorize file changes.

To inspect progress from Terminal:

```sh
npm start -- status
```

To cancel running work, say:

> DeepSeek, cancel the parser task.

Cancellation stops the running task; it cannot undo edits already made. Review the resulting files and tests before using the changes. Publishing code or opening a pull request remains a separate, reviewed step.

## 5. Stop when finished

Press **Ctrl+C** in the original Terminal window. Alternatively, in another Terminal window in this project folder, run:

```sh
npm stop
```

Wait for the stopped confirmation. This cancels running and unapproved work, makes the owned bot leave, removes its MIA configuration, and closes the bridge's own ngrok connection. Other meeting participants remain. A public connection you configured yourself is not stopped by the bridge.

You can also stop during startup or while its model check is running. Repeated `npm stop` is safe, including before your first start. If cleanup cannot be confirmed because of a network or service error, keep `.state` and `.env`, restore connectivity, and run `npm stop` again. Closing a Terminal window is not a substitute for confirmed cleanup.

Normal `npm start` does not run the development test suite or launch scripted speech. If you separately run `npm test` or an acceptance script, press Ctrl+C in **that test's Terminal window** to stop it. `npm stop` controls the bridge and its owned work; it does not kill unrelated test windows or services.

## Correct a saved setting

Stop the bridge first. On a Mac, run `open -e .env` from this project folder to open the private settings file. Change the value after the relevant `=`, save the file without adding `.txt`, then run `npm start` again. Keep the file private. For another meeting, normally just start again and paste the new link when asked.

## Quick fixes

| What you see | What to do |
|---|---|
| `npm` or `git` is not found | Install the tools in step 1 and reopen Terminal. |
| Harness version or installation error | Install exactly `0.2.1-rc.5`, then retry. The guide intentionally pins the tested version. |
| DeepSeek authentication error | Check the selected DeepSeek API key and its model permissions. API-key authentication and Harness account reuse are separate options. |
| DeepSeek insufficient-balance error / HTTP 402 | Check the selected provider's API billing and usage limits, then retry once access is restored. |
| `ngrok could not connect` | Check installation, authtoken and ngrok account limits. Stop another ngrok agent only if it belongs to you and you no longer need it. |
| Repository error | Supply the folder of a Git checkout, not the bridge folder or a ZIP without `.git`. |
| Another bridge owns this state | Run `npm stop` in this folder before starting again. |
| The assistant is waiting | Ask the host to admit it and allow the required meeting permissions. |
| No spoken answer | Check your microphone and MeetStream's Gemini integration. Speak clearly in a quiet environment; inspect `npm start -- status` before repeating or approving work. |
| Cleanup is pending | Keep the private files and retry `npm stop` when connectivity returns. Do not delete `.state`. |

Keep `.env`, `.state` and Harness session history private. The bridge requests 48-hour retention for MeetStream media; stopping the bot does not erase recordings or local history.

For account reuse, custom public connections and technical details, see [README.md](README.md).
