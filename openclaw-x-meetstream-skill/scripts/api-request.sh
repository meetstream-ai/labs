#!/usr/bin/env bash
# Advanced operations documented in references/API-REFERENCE.md.
# Usage: api-request.sh METHOD /relative/path [--body-file FILE|-] [--idempotency-key UUID]
# Emits the raw JSON response. Does not retry or follow redirects.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
if [[ "${1:-}" == "--help" ]]; then
  sed -n '2,4p' "${BASH_SOURCE[0]}"
  exit 0
fi
[[ $# -ge 2 ]] || { echo "Usage: api-request.sh METHOD /relative/path [--body-file FILE|-] [--idempotency-key UUID]" >&2; exit 64; }
method="$1"; endpoint="$2"; shift 2
case "$method" in GET|POST|PUT|PATCH|DELETE) ;; *) echo "error: unsupported HTTP method" >&2; exit 64 ;; esac
if [[ ! "$endpoint" =~ ^/[A-Za-z0-9] || "$endpoint" == *[[:space:]]* || "$endpoint" == *'#'* || "$endpoint" == *'\'* || "$endpoint" == *'..'* || "$endpoint" == /api/* ]]; then
  echo "error: use an API-relative path such as /mia, without /api/v1, fragments, or traversal" >&2
  exit 64
fi
body=""; body_file=""; idempotency_key=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --body-file) ms_require_option_value "$1" "${2-}"; body_file="$2"; shift 2 ;;
    --idempotency-key) ms_require_option_value "$1" "${2-}"; idempotency_key="$2"; shift 2 ;;
    *) echo "error: unknown argument '$1'" >&2; exit 64 ;;
  esac
done
ms_check_deps
ms_require_api_key
if [[ -n "$body_file" ]]; then
  if [[ "$body_file" == "-" ]]; then body="$(cat)";
  else
    [[ -f "$body_file" && -r "$body_file" ]] || { echo "error: body file is not readable" >&2; exit 64; }
    body="$(cat "$body_file")"
  fi
  jq -e 'type == "object"' >/dev/null 2>&1 <<<"$body" || { echo "error: body must be a JSON object" >&2; exit 64; }
fi
if [[ -n "$idempotency_key" ]]; then
  [[ "$method" == POST && "$endpoint" == /bots/create_bot && "$idempotency_key" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]] || {
    echo "error: idempotency key must be a UUID and is supported only for POST /bots/create_bot" >&2; exit 64;
  }
fi
ms_request "$method" "$endpoint" "$body" "$idempotency_key"
