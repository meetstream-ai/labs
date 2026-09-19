#!/usr/bin/env bash
# install.sh - one-command setup for the MeetStream OpenClaw skill.
#
# Usage:
#   ./install.sh                          interactive
#   printf '%s\n' "$MEETSTREAM_API_KEY" | ./install.sh --api-key-stdin
#   ./install.sh --workspace /path        override OpenClaw workspace detection
#   ./install.sh --no-restart             skip `openclaw gateway restart`
#
# What it does, in order:
#   1. Finds your OpenClaw workspace (via `openclaw config get agents.defaults.workspace`,
#      falling back to ~/.openclaw/workspace)
#   2. Copies this skill into <workspace>/skills/meetstream (or updates it
#      in place if you're already running from there)
#   3. Checks for curl/jq, installing with Homebrew (macOS) or apt (Linux/WSL)
#   4. Writes MEETSTREAM_API_KEY into a mode-0600 .env file next to the skill, so it
#      loads automatically (no shell-profile editing required)
#   5. Runs the offline test suite against the installed copy
#   6. Restarts the OpenClaw gateway (if the CLI is available) so it
#      discovers the new skill
#   7. Runs doctor.sh for a final pass/fail summary

set -uo pipefail
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

api_key=""
read_api_key_stdin=false
workspace_override=""
do_restart=true
non_interactive=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-key)
      echo "error: --api-key is unsafe because secrets leak through process arguments; use --api-key-stdin" >&2
      exit 64
      ;;
    --api-key-stdin) read_api_key_stdin=true; non_interactive=true; shift ;;
    --workspace)
      if [[ -z "${2-}" || "${2-}" == --* ]]; then echo "error: --workspace requires a path" >&2; exit 64; fi
      workspace_override="$2"; shift 2
      ;;
    --no-restart) do_restart=false; shift ;;
    --yes|-y) non_interactive=true; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "error: unknown argument '$1'" >&2; exit 64 ;;
  esac
done

if $read_api_key_stdin; then
  if ! IFS= read -r api_key; then
    echo "error: --api-key-stdin requires one line on standard input" >&2
    exit 64
  fi
fi

validate_api_key() {
  local key="$1"
  if [[ -z "$key" || "$key" == *$'\n'* || "$key" == *$'\r'* ]]; then
    echo "error: MeetStream API key must be one non-empty line" >&2
    exit 64
  fi
}

write_api_key_file() {
  local key="$1" destination="$2" tmp
  validate_api_key "$key"
  if [[ -L "$destination" ]]; then
    echo "error: refusing to write API key through symlink: $destination" >&2
    exit 78
  fi
  umask 077
  tmp="$(mktemp "${destination}.tmp.XXXXXX")"
  trap 'rm -f "$tmp"' EXIT HUP INT TERM
  printf 'MEETSTREAM_API_KEY=%s\n' "$key" > "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$destination"
  trap - EXIT HUP INT TERM
}

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "Locating OpenClaw workspace"
if [[ -n "$workspace_override" ]]; then
  WORKSPACE="$workspace_override"
  echo "Using --workspace override: $WORKSPACE"
elif command -v openclaw >/dev/null 2>&1; then
  WORKSPACE="$(openclaw config get agents.defaults.workspace 2>/dev/null | sed -e 's/^"//' -e 's/"$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ -z "$WORKSPACE" ]]; then
    WORKSPACE="$HOME/.openclaw/workspace"
    echo "Could not read workspace from openclaw config; defaulting to $WORKSPACE"
  else
    echo "Found via openclaw config get agents.defaults.workspace: $WORKSPACE"
  fi
else
  WORKSPACE="$HOME/.openclaw/workspace"
  echo "openclaw CLI not found on PATH; defaulting to $WORKSPACE"
fi

# Expand a leading ~/ to $HOME if the user passed a tilde path.
case "$WORKSPACE" in
  "~"*) WORKSPACE="$HOME/${WORKSPACE#~}" ;;
esac

TARGET="$WORKSPACE/skills/meetstream"
mkdir -p "$WORKSPACE/skills"
if [[ -L "$TARGET" ]]; then
  echo "error: refusing to install through symlinked target: $TARGET" >&2
  exit 78
fi

step "Installing skill files"
if [[ "$SRC_DIR" == "$TARGET" ]]; then
  echo "Already running from $TARGET - nothing to copy."
else
  if [[ -d "$TARGET" ]]; then
    echo "$TARGET already exists - updating in place (your .env is preserved)."
  else
    mkdir -p "$TARGET"
  fi
  for item in SKILL.md README.md QUICKSTART.md LICENSE SECURITY.md .env.example install.sh setup-macos.command setup-windows.cmd scripts skills references tests; do
    rm -rf "${TARGET:?}/${item:?}"
    cp -R "$SRC_DIR/$item" "$TARGET/"
  done
  echo "Installed to $TARGET"
fi
chmod +x "$TARGET"/install.sh "$TARGET"/setup-macos.command "$TARGET"/scripts/*.sh "$TARGET"/tests/run_tests.sh

# Install focused companion skills as siblings so OpenClaw routes each one.
for companion_source in "$SRC_DIR"/skills/*; do
  [[ -d "$companion_source" ]] || continue
  companion_name="$(basename "$companion_source")"
  companion_target="$WORKSPACE/skills/$companion_name"
  if [[ -L "$companion_target" ]]; then
    echo "error: refusing to install through symlinked target: $companion_target" >&2
    exit 78
  fi
  rm -rf "${companion_target:?}"
  cp -R "$companion_source" "$companion_target"
done
echo "Installed focused bot-builder, notetaker, debugger, and calendar skills."

step "Checking dependencies"
missing=()
command -v curl >/dev/null 2>&1 || missing+=(curl)
command -v jq   >/dev/null 2>&1 || missing+=(jq)
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Missing: ${missing[*]}"
  if command -v brew >/dev/null 2>&1; then
    echo "Installing via Homebrew: brew install ${missing[*]}"
    brew install "${missing[@]}"
  elif command -v apt-get >/dev/null 2>&1; then
    echo "Installing via apt: sudo apt-get update && sudo apt-get install -y ${missing[*]}"
    sudo apt-get update && sudo apt-get install -y "${missing[@]}"
  else
    echo "No supported package manager was found. Install manually: ${missing[*]}" >&2
    echo "  macOS: brew install ${missing[*]}" >&2
    echo "  Windows/WSL Ubuntu: sudo apt-get update && sudo apt-get install -y ${missing[*]}" >&2
    exit 127
  fi
else
  echo "curl and jq are present."
fi

step "Configuring MEETSTREAM_API_KEY"
ENV_FILE="$TARGET/.env"
if [[ -L "$ENV_FILE" ]]; then
  echo "error: refusing to use symlinked credential file: $ENV_FILE" >&2
  exit 78
fi
if [[ -n "$api_key" ]]; then
  write_api_key_file "$api_key" "$ENV_FILE"
  echo "Wrote key to $ENV_FILE"
elif [[ -f "$ENV_FILE" ]] && grep -q '^MEETSTREAM_API_KEY=' "$ENV_FILE" 2>/dev/null; then
  chmod 600 "$ENV_FILE"
  echo ".env already has MEETSTREAM_API_KEY set - leaving it as is."
elif [[ -n "${MEETSTREAM_API_KEY:-}" ]]; then
  write_api_key_file "$MEETSTREAM_API_KEY" "$ENV_FILE"
  echo "Copied MEETSTREAM_API_KEY from your current shell into $ENV_FILE"
elif ! $non_interactive && [[ -t 0 ]]; then
  read -rsp "Paste your MeetStream API key (from https://app.meetstream.ai/api-key), or press Enter to skip: " api_key
  echo
  if [[ -n "$api_key" ]]; then
    write_api_key_file "$api_key" "$ENV_FILE"
    echo "Wrote key to $ENV_FILE"
  else
    echo "Skipped. Add it later: cp $TARGET/.env.example $ENV_FILE and edit it."
  fi
else
  echo "No key provided and running non-interactively. Add it later:"
  echo "  cp $TARGET/.env.example $ENV_FILE   # then edit it"
fi

step "Running offline test suite"
if bash "$TARGET/tests/run_tests.sh"; then
  echo "Tests passed."
else
  echo "Tests failed - installation stopped before gateway restart." >&2
  exit 1
fi

if $do_restart && command -v openclaw >/dev/null 2>&1; then
  step "Restarting OpenClaw gateway so it discovers the skill"
  openclaw gateway restart || echo "Gateway restart failed or wasn't running - restart manually: openclaw gateway restart" >&2
fi

step "Final check"
if [[ -n "$workspace_override" ]]; then
  MEETSTREAM_SKIP_OPENCLAW_DISCOVERY=1 bash "$TARGET/scripts/doctor.sh"
else
  bash "$TARGET/scripts/doctor.sh"
fi
doctor_status=$?

echo
if [[ $doctor_status -eq 0 ]]; then
  bold "Install complete: $TARGET"
  echo "Open OpenClaw and say: Show me the MIA agents I can use."
else
  bold "Install finished with warnings - see doctor output above."
fi
exit $doctor_status
