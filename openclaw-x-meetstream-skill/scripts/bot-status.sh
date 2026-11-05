#!/usr/bin/env bash
# bot-status.sh - poll a bot's current status.
#
# Usage: bot-status.sh BOT_ID [--json]
#
# GET /api/v1/bots/:bot_id/status

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

bot_id=""
json_only=false
for arg in "$@"; do
  case "$arg" in
    --json) json_only=true ;;
    -h|--help) echo "Usage: $(basename "$0") BOT_ID [--json]"; exit 0 ;;
    -*) echo "error: unknown flag '$arg'" >&2; exit 64 ;;
    *)
      if [[ -n "$bot_id" ]]; then
        echo "error: pass exactly one BOT_ID" >&2
        exit 64
      fi
      bot_id="$arg"
      ;;
  esac
done

ms_check_deps
ms_require_api_key

if [[ -z "$bot_id" ]]; then
  echo "error: BOT_ID is required" >&2
  exit 64
fi
ms_validate_bot_id "$bot_id"

encoded_bot_id="$(ms_urlencode "$bot_id")"
resp="$(ms_get "/bots/${encoded_bot_id}/status")"

if $json_only; then
  echo "$resp"
  exit 0
fi

echo "$resp" | jq -r '"bot_id: \(.bot_id)\nstatus: \(.status)"'
