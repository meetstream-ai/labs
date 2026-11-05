#!/usr/bin/env bash
# List calendar events or schedule/unschedule a MeetStream bot for an event.
# Usage: calendar-bots.sh list [--json]
#        calendar-bots.sh schedule|unschedule EVENT_ID [--json]

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

action="${1:-}"
event_id="${2:-}"
json_only=false
[[ "${2:-}" == "--json" || "${3:-}" == "--json" ]] && json_only=true

ms_check_deps
ms_require_api_key
case "$action" in
  list)
    [[ $# -eq 1 || ( $# -eq 2 && "${2:-}" == "--json" ) ]] || { echo "Usage: $(basename "$0") list [--json]" >&2; exit 64; }
    resp="$(ms_get "/calendar/events")"
    ;;
  schedule|unschedule)
    [[ -n "$event_id" && "$event_id" != "--json" && $# -le 3 ]] || { echo "Usage: $(basename "$0") schedule|unschedule EVENT_ID [--json]" >&2; exit 64; }
    encoded="$(ms_urlencode "$event_id")"
    if [[ "$action" == "schedule" ]]; then resp="$(ms_post "/calendar/schedule/$encoded")"; else resp="$(ms_delete "/calendar/schedule/$encoded")"; fi
    ;;
  *) echo "Usage: $(basename "$0") list [--json] | schedule|unschedule EVENT_ID [--json]" >&2; exit 64 ;;
esac

if $json_only; then echo "$resp"; else echo "$resp" | jq; fi
