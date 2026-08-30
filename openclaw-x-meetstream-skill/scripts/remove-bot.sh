#!/usr/bin/env bash
# remove-bot.sh - pull a bot out of its meeting.
#
# Usage:
#   remove-bot.sh BOT_ID [--json]
#   remove-bot.sh --current [--json]
#
# --current resolves the bot to remove via list-bots.sh --active. If more
# than one bot looks active, this script refuses to guess and lists the
# candidates so the caller can re-run with an explicit BOT_ID instead.
#
# GET /api/v1/bots/:bot_id/remove_bot

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

bot_id=""
use_current=false
json_only=false

for arg in "$@"; do
  case "$arg" in
    --current) use_current=true ;;
    --json) json_only=true ;;
    -h|--help)
      echo "Usage: $(basename "$0") BOT_ID|--current [--json]"
      exit 0
      ;;
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

if $use_current && [[ -n "$bot_id" ]]; then
  echo "error: pass either BOT_ID or --current, not both" >&2
  exit 64
fi

if $use_current; then
  active_json="$("$SCRIPT_DIR/list-bots.sh" --active --json)"
  if [[ "$(jq -r '.hasNextPage // false' <<<"$active_json")" == "true" ]]; then
    echo "More bots exist beyond the first API page; specify a BOT_ID instead of --current." >&2
    exit 1
  fi
  count="$(jq '.bots | length' <<<"$active_json")"
  if [[ "$count" -eq 0 ]]; then
    echo "No active bots found to remove." >&2
    exit 1
  elif [[ "$count" -gt 1 ]]; then
    echo "More than one bot looks active; specify which one to remove:" >&2
    jq -r '.bots[] | "  - \(.bot_id // .id)  status: \(.status)  meeting: \(.meeting_url // "?")"' <<<"$active_json" >&2
    exit 1
  fi
  bot_id="$(jq -r '.bots[0].bot_id // .bots[0].id' <<<"$active_json")"
fi

if [[ -z "$bot_id" ]]; then
  echo "error: BOT_ID is required (or pass --current)" >&2
  exit 64
fi
ms_validate_bot_id "$bot_id"

encoded_bot_id="$(ms_urlencode "$bot_id")"
resp="$(ms_get "/bots/${encoded_bot_id}/remove_bot")"

if $json_only; then
  echo "$resp"
  exit 0
fi

echo "$resp" | jq -r --arg bot_id "$bot_id" '.message // "Stop signal sent for bot \($bot_id)."'
