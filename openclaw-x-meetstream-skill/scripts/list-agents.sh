#!/usr/bin/env bash
# list-agents.sh - list the MeetStream Infrastructure Agents (MIA) available
# in this account, so the user can pick one by name for send-bot.sh.
#
# Usage: list-agents.sh [--json]
#
# GET /api/v1/mia

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

json_only=false
for arg in "$@"; do
  case "$arg" in
    --json) json_only=true ;;
    -h|--help)
      echo "Usage: $(basename "$0") [--json]"
      exit 0
      ;;
    *)
      echo "error: unknown argument '$arg'" >&2
      exit 64
      ;;
  esac
done

ms_check_deps
ms_require_api_key

resp="$(ms_get "/mia")"

if $json_only; then
  echo "$resp"
  exit 0
fi

count="$(jq -r '.count // (.agent_configs | length)' <<<"$resp")"
if [[ "$count" -eq 0 ]]; then
  echo "No MIA agents found. Create one at https://app.meetstream.ai (MIA tab)."
  exit 0
fi

echo "Available MIA agents ($count):"
echo "$resp" | jq -r '
  .agent_configs[] |
  "- \(.AgentName)  [id: \(.AgentConfigID)]\n" +
  "    mode: \(.Mode)" +
  (if .Model.model then "  model: \(.Model.provider // "?")/\(.Model.model)" else "" end)
'
