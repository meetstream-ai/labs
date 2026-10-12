#!/usr/bin/env bash
# End-to-end demo: Hermes agent -> MeetStream MCP -> MeetStream bot -> real meeting -> bot speaks.
#
#   scripts/demo.sh <meeting-url> [agent_config_id]
#
# The agent_config_id is a MIA voice agent (the part that speaks). If you omit it and
# MEETSTREAM_MIA_AGENT_ID is unset, the script creates one from examples/mia-intro-agent.json
# with the official MeetStream CLI - which needs MEETSTREAM_API_KEY exported in this shell.
#
# This script never prints your API key and never writes it anywhere.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MEETING_URL="${1:-}"
AGENT_ID="${2:-${MEETSTREAM_MIA_AGENT_ID:-}}"

die() { printf 'demo: %s\n' "$*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

[[ -n "$MEETING_URL" ]] || die "usage: scripts/demo.sh <meeting-url> [agent_config_id]"
[[ "$MEETING_URL" =~ ^https://(meet\.google\.com|([a-z0-9-]+\.)?zoom\.us|teams\.(microsoft|live)\.com)/ ]] \
  || die "expected a Google Meet, Zoom or Microsoft Teams URL, got: $MEETING_URL"

step "Preflight"
command -v hermes >/dev/null || die "hermes is not on PATH - install Hermes Agent first"
PLUGIN_INFO="$(hermes plugins show meetstream 2>/dev/null || true)"
[[ "$PLUGIN_INFO" == *"Status: enabled"* ]] \
  || die "plugin not enabled - run: hermes plugins install meetstream-ai/hermes-plugin --enable"
ENV_FILE="$(hermes config env-path 2>/dev/null || true)"
if [[ -z "${MEETSTREAM_API_KEY:-}" ]] && ! grep -q '^MEETSTREAM_API_KEY=.' "${ENV_FILE:-/dev/null}" 2>/dev/null; then
  die "MEETSTREAM_API_KEY is not set - run: hermes config set MEETSTREAM_API_KEY <your key>"
fi
echo "hermes, plugin and MEETSTREAM_API_KEY: ok"

if [[ -z "$AGENT_ID" ]]; then
  step "Creating a MIA voice agent from examples/mia-intro-agent.json"
  [[ -n "${MEETSTREAM_API_KEY:-}" ]] || die "export MEETSTREAM_API_KEY in this shell (or pass an agent_config_id) to create the voice agent"
  command -v npx >/dev/null || die "npx (Node 18+) is required to create the voice agent"
  OUT="$(npx -y @meetstream/cli mia create -f "$ROOT/examples/mia-intro-agent.json")"
  AGENT_ID="$(printf '%s' "$OUT" | grep -o '"agent_config_id": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
  [[ -n "$AGENT_ID" ]] || die "could not read agent_config_id from the CLI output"
  echo "agent_config_id: $AGENT_ID  (reuse it: export MEETSTREAM_MIA_AGENT_ID=$AGENT_ID)"
fi

NS="agent-plugin-meetstream-$(printf 'meetstream' | shasum -a 256 | cut -c1-8)"
PROMPT="Join my meeting at $MEETING_URL and introduce yourself out loud.
Use the MeetStream MIA voice agent with agent_config_id $AGENT_ID so the bot can speak, name the bot \"Hermes\", and do not record video.
Once the bot is in the meeting (poll its status every 10 seconds for up to 5 minutes - a host may need to admit it), also post a one-line hello in the meeting chat.
Finish by telling me the bot_id and the bot's latest status."

step "Running Hermes (admit the bot named \"Hermes\" from the meeting's waiting room when it appears)"
hermes -z "$PROMPT" --skills "$NS:join-meeting,$NS:speak-in-meeting,$NS:meeting-chat"

step "Done"
cat <<EOF
Expected in the meeting: a participant named "Hermes" joins, says its introduction out loud,
and posts a hello in chat. When you are finished:

  hermes -z "Remove my MeetStream bot from the meeting at $MEETING_URL"
EOF
