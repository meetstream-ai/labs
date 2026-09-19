#!/usr/bin/env bash
# Post a message into a live meeting through an active MeetStream bot.
# Usage: send-chat.sh BOT_ID --message TEXT [--json]

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

bot_id=""
message=""
json_only=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --message) ms_require_option_value "$1" "${2-}"; message="$2"; shift 2 ;;
    --json) json_only=true; shift ;;
    -*) echo "error: unknown flag '$1'" >&2; exit 64 ;;
    *) [[ -z "$bot_id" ]] || { echo "error: pass exactly one BOT_ID" >&2; exit 64; }; bot_id="$1"; shift ;;
  esac
done

[[ -n "$bot_id" && -n "$message" ]] || { echo "Usage: $(basename "$0") BOT_ID --message TEXT [--json]" >&2; exit 64; }
[[ ${#message} -le 4000 ]] || { echo "error: --message must be at most 4000 characters" >&2; exit 64; }
ms_check_deps
ms_require_api_key
ms_validate_bot_id "$bot_id"
encoded="$(ms_urlencode "$bot_id")"
payload="$(jq -n --arg message "$message" '{message:$message,metadata:{message_type:"text"}}')"
resp="$(ms_post "/bots/$encoded/send_message" "$payload")"

if $json_only; then echo "$resp"; else echo "$resp" | jq -r '.message // "Message sent to the meeting."'; fi
