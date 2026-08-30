# MeetStream for OpenClaw

Install the MeetStream skill in a few minutes. Choose the instructions for
your computer.

## Before you start

You need:

- OpenClaw installed, onboarded, and connected to an OpenAI model.
- A MeetStream account: <https://meetstream.ai>
- Your MeetStream API key: <https://app.meetstream.ai/api-key>
- This project folder, unzipped as `openclaw-x-meetstream-skill`.

The installer asks for the API key privately, installs the skill, runs its
checks, and restarts the OpenClaw Gateway. Never put the key in a source file.

## macOS

1. Open Terminal and install OpenClaw with the official installer:

   ```bash
   curl -fsSL https://openclaw.ai/install.sh | bash
   openclaw onboard
   ```

2. Open the `openclaw-x-meetstream-skill` folder in Finder.
3. Double-click **`setup-macos.command`**.
4. Paste your MeetStream API key when asked. Nothing appears while you type.
5. When setup says it finished, open OpenClaw and say:

   > Show me the MIA agents I can use.

If macOS blocks the first launch, Control-click the file, choose **Open**, and
confirm. You can also open the folder in VS Code and run `bash install.sh` in
its terminal.

## Windows

The installer runs the skill in Ubuntu on WSL2, which provides the Bash tools
the skill uses.

1. Install WSL2. Open **PowerShell as Administrator** and run:

   ```powershell
   wsl --install -d Ubuntu-24.04
   ```

2. Restart Windows if asked, then open Ubuntu once and complete its setup.
3. Install and onboard OpenClaw inside Ubuntu:

   ```bash
   curl -fsSL https://openclaw.ai/install.sh | bash
   openclaw onboard
   ```

   See the [official Windows/WSL2 guide](https://docs.openclaw.ai/windows) if
   Ubuntu setup needs help.
4. Open the `openclaw-x-meetstream-skill` folder in File Explorer.
5. Double-click **`setup-windows.cmd`**.
6. Paste your MeetStream API key when asked and wait for setup to finish.
7. Open OpenClaw and say:

   > Show me the MIA agents I can use.

Do not run `install.sh` in PowerShell or Command Prompt. If you use VS Code,
open the folder through **WSL: Open Folder in WSL** and run `bash install.sh` in
the WSL terminal.

## If setup reports an error

Open a macOS Terminal or Ubuntu/WSL terminal in this folder and run:

```bash
bash install.sh
```

The final health check should report that the MeetStream skill is eligible.
For help, see the technical reference in [README.md](./README.md).

The linked [OpenClaw](https://docs.openclaw.ai/install) and
[MeetStream](https://docs.meetstream.ai/guides/get-started/create-your-first-bot)
guides are the source of truth for account setup, platform requirements, and
API behavior.

## What you can say after setup

- “Show me the MIA agents I can use.”
- “Send my standup agent to `<meeting URL>`.”
- “What bots are in a call right now?”
- “Remove the bot from the current call.”
- “Get the transcript and summary from bot `<id>`.”
- “Schedule a bot for my weekly standup.”

Only send or remove a bot when you are authorized to affect that meeting.
