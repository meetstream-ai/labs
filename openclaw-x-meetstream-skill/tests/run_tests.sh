#!/usr/bin/env bash
# run_tests.sh - exercises every script in scripts/ against a local mock of
# the MeetStream API. Included with the installable bundle so installations
# and security reviewers can verify behavior without a production API call.

set -uo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$TEST_DIR/.." && pwd)"
SCRIPTS="$SKILL_DIR/scripts"
TMP_DIR="$(mktemp -d)"
PORT_FILE="$TMP_DIR/port"

pass=0
fail=0

check() {
  local desc="$1" expected_code="$2" actual_code="$3"
  if [[ "$actual_code" -eq "$expected_code" ]]; then
    echo "PASS: $desc"
    pass=$((pass+1))
  else
    echo "FAIL: $desc (expected exit $expected_code, got $actual_code)"
    fail=$((fail+1))
  fi
}

check_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then
    echo "PASS: $desc"
    pass=$((pass+1))
  else
    echo "FAIL: $desc (did not find '$needle')"
    echo "--- output was ---"
    echo "$haystack"
    echo "------------------"
    fail=$((fail+1))
  fi
}

# --- start mock server ---
python3 "$TEST_DIR/mock_server.py" 0 "$PORT_FILE" &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null; rm -rf "$TMP_DIR"' EXIT HUP INT TERM
for _ in {1..50}; do
  [[ -s "$PORT_FILE" ]] && break
  sleep 0.1
done
if [[ ! -s "$PORT_FILE" ]]; then
  echo "FAIL: mock server did not start"
  exit 1
fi
PORT="$(cat "$PORT_FILE")"

export MEETSTREAM_API_BASE="http://127.0.0.1:${PORT}/api/v1"
export MEETSTREAM_TEST_MODE=1

echo "== dependency / config guard tests (no API key) =="
unset MEETSTREAM_API_KEY 2>/dev/null || true
# Isolate from any real .env this skill was installed with (e.g. by
# install.sh) so this guard test is deterministic regardless of install state.
out="$(MEETSTREAM_SKIP_DOTENV=1 "$SCRIPTS/list-agents.sh" 2>&1)"; code=$?
check "list-agents.sh fails cleanly with no API key" 78 "$code"
check_contains "list-agents.sh error mentions MEETSTREAM_API_KEY" "MEETSTREAM_API_KEY" "$out"

out="$("$SKILL_DIR/install.sh" --api-key should-not-be-on-argv 2>&1)"; code=$?
check "install.sh rejects API keys in process arguments" 64 "$code"

echo
echo "== happy path tests (with API key) =="
export MEETSTREAM_API_KEY="test-key"

out="$("$SCRIPTS/list-agents.sh" 2>&1)"; code=$?
check "list-agents.sh succeeds" 0 "$code"
check_contains "list-agents.sh shows Sales Notetaker" "Sales Notetaker" "$out"
check_contains "list-agents.sh shows agent id" "agent-1" "$out"

out="$("$SCRIPTS/list-agents.sh" --json 2>&1)"; code=$?
check "list-agents.sh --json succeeds" 0 "$code"
check_contains "list-agents.sh --json is valid JSON" "agent_configs" "$out"

out="$("$SCRIPTS/list-bots.sh" 2>&1)"; code=$?
check "list-bots.sh succeeds" 0 "$code"
check_contains "list-bots.sh shows active bot" "bot-active-1" "$out"
check_contains "list-bots.sh shows done bot" "bot-done-1" "$out"

out="$("$SCRIPTS/list-bots.sh" --active 2>&1)"; code=$?
check "list-bots.sh --active succeeds" 0 "$code"
check_contains "list-bots.sh --active includes active bot" "bot-active-1" "$out"
if grep -q "bot-done-1" <<<"$out"; then
  echo "FAIL: list-bots.sh --active should have filtered out bot-done-1"
  fail=$((fail+1))
else
  echo "PASS: list-bots.sh --active filtered out bot-done-1"
  pass=$((pass+1))
fi

out="$("$SCRIPTS/bot-status.sh" bot-active-1 2>&1)"; code=$?
check "bot-status.sh succeeds for known bot" 0 "$code"
check_contains "bot-status.sh reports status" "InCallRecording" "$out"

out="$("$SCRIPTS/bot-status.sh" no-such-bot 2>&1)"; code=$?
check "bot-status.sh fails for unknown bot" 1 "$code"

out="$("$SCRIPTS/send-bot.sh" --link "https://meet.google.com/abc-defg-hij" --name "Notetaker" 2>&1)"; code=$?
check "send-bot.sh succeeds with required args" 0 "$code"
check_contains "send-bot.sh reports new bot_id" "bot-new-1" "$out"

out="$("$SCRIPTS/send-bot.sh" --link "https://meet.google.com/abc-defg-hij" --name "Notetaker" --agent-name "standup" 2>&1)"; code=$?
check "send-bot.sh resolves --agent-name" 0 "$code"

out="$("$SCRIPTS/send-bot.sh" --link "https://meet.google.com/abc-defg-hij" --name "Post-call Bot" --no-video --transcription deepgram --language en --retention-hours 24 --separate-audio --idempotency-key "123e4567-e89b-12d3-a456-426614174000" 2>&1)"; code=$?
check "send-bot.sh builds a post-call transcription bot" 0 "$code"

out="$("$SCRIPTS/send-bot.sh" --link "https://meet.google.com/abc-defg-hij" --name "Live Bot" --transcription deepgram_streaming 2>&1)"; code=$?
check "send-bot.sh requires a webhook for streaming transcription" 64 "$code"

out="$("$SCRIPTS/send-bot.sh" --link "https://meet.google.com/abc-defg-hij" --name "Live Bot" --transcription deepgram_streaming --live-transcript "https://example.com/transcripts" 2>&1)"; code=$?
check "send-bot.sh builds a live transcription bot" 0 "$code"

out="$("$SCRIPTS/send-bot.sh" --link "https://meet.google.com/abc-defg-hij" --name "Bad Retention" --retention-hours zero 2>&1)"; code=$?
check "send-bot.sh rejects invalid retention" 64 "$code"

out="$("$SCRIPTS/send-bot.sh" --link "https://meet.google.com/abc-defg-hij" --name "Bad Retry" --idempotency-key nope 2>&1)"; code=$?
check "send-bot.sh rejects invalid idempotency key" 64 "$code"

out="$("$SCRIPTS/send-bot.sh" --name "Notetaker" 2>&1)"; code=$?
check "send-bot.sh rejects missing --link" 64 "$code"

out="$("$SCRIPTS/send-bot.sh" --link "not-a-url" --name "Notetaker" 2>&1)"; code=$?
check "send-bot.sh rejects malformed --link" 64 "$code"

out="$("$SCRIPTS/send-bot.sh" --link "https://attacker.example/meeting" --name "Notetaker" 2>&1)"; code=$?
check "send-bot.sh rejects unsupported meeting host" 64 "$code"

out="$("$SCRIPTS/send-bot.sh" --link 2>&1)"; code=$?
check "send-bot.sh reports a dangling option as usage error" 64 "$code"

out="$("$SCRIPTS/send-bot.sh" --link "https://meet.google.com/x" --name "N" --agent-name "a" 2>&1)"; code=$?
check "send-bot.sh refuses ambiguous --agent-name match" 1 "$code"
check_contains "send-bot.sh lists both ambiguous agents" "Sales Notetaker" "$out"

out="$("$SCRIPTS/remove-bot.sh" --current 2>&1)"; code=$?
check "remove-bot.sh --current refuses multiple active bots" 1 "$code"
check_contains "remove-bot.sh lists ambiguous active bots" "More than one bot" "$out"

out="$("$SCRIPTS/remove-bot.sh" bot-active-1 2>&1)"; code=$?
check "remove-bot.sh succeeds for known bot" 0 "$code"
check_contains "remove-bot.sh reports stop signal" "Stop signal sent" "$out"

curl -sS -H "Authorization: Token test-key" "${MEETSTREAM_API_BASE}/test/force-next-page" >/dev/null
out="$("$SCRIPTS/remove-bot.sh" --current 2>&1)"; code=$?
check "remove-bot.sh --current fails closed when more API pages exist" 1 "$code"
check_contains "remove-bot.sh explains pagination ambiguity" "beyond the first API page" "$out"

out="$("$SCRIPTS/remove-bot.sh" --current 2>&1)"; code=$?
check "remove-bot.sh --current resolves the sole active bot" 0 "$code"

out="$("$SCRIPTS/remove-bot.sh" 2>&1)"; code=$?
check "remove-bot.sh rejects missing bot id" 64 "$code"

out="$("$SCRIPTS/remove-bot.sh" bot-active-1 --current 2>&1)"; code=$?
check "remove-bot.sh rejects BOT_ID + --current together" 64 "$code"

out="$("$SCRIPTS/bot-status.sh" 'bot-active-1/remove_bot#' 2>&1)"; code=$?
check "bot-status.sh rejects path syntax in BOT_ID" 64 "$code"

echo
echo "== bot-building data and interaction tests =="
out="$("$SCRIPTS/bot-data.sh" summary bot-active-1 2>&1)"; code=$?
check "bot-data.sh gets a meeting summary" 0 "$code"
check_contains "bot-data.sh summary contains result" "launch plan" "$out"

out="$("$SCRIPTS/bot-data.sh" participants bot-active-1 --json 2>&1)"; code=$?
check "bot-data.sh gets participants" 0 "$code"
check_contains "bot-data.sh participants contains Alice" "Alice" "$out"

out="$("$SCRIPTS/get-transcript.sh" bot-active-1 2>&1)"; code=$?
check "get-transcript.sh resolves and fetches transcript" 0 "$code"
check_contains "get-transcript.sh formats speaker text" "Alice: We approved" "$out"

out="$("$SCRIPTS/send-chat.sh" bot-active-1 --message "The agenda is in the document." 2>&1)"; code=$?
check "send-chat.sh sends an in-meeting message" 0 "$code"
check_contains "send-chat.sh reports success" "Message sent" "$out"

out="$("$SCRIPTS/send-chat.sh" bot-active-1 2>&1)"; code=$?
check "send-chat.sh rejects a missing message" 64 "$code"

out="$("$SCRIPTS/calendar-bots.sh" list --json 2>&1)"; code=$?
check "calendar-bots.sh lists events" 0 "$code"
check_contains "calendar-bots.sh lists the standup" "Weekly standup" "$out"

out="$("$SCRIPTS/calendar-bots.sh" schedule event-1 2>&1)"; code=$?
check "calendar-bots.sh schedules an event bot" 0 "$code"

out="$("$SCRIPTS/calendar-bots.sh" unschedule event-1 2>&1)"; code=$?
check "calendar-bots.sh unschedules an event bot" 0 "$code"

echo
echo "== configuration hardening tests =="
SAFE_SKILL="$TMP_DIR/safe-skill"
mkdir -p "$SAFE_SKILL"
cp -R "$SCRIPTS" "$SAFE_SKILL/scripts"
marker="$TMP_DIR/should-not-exist"
printf "# comment lines are allowed\n\nMEETSTREAM_API_KEY=\$(touch %s)\n" "$marker" > "$SAFE_SKILL/.env"
out="$(MEETSTREAM_API_BASE="$MEETSTREAM_API_BASE" MEETSTREAM_TEST_MODE=1 MEETSTREAM_SKIP_DOTENV="" "$SAFE_SKILL/scripts/list-agents.sh" 2>&1)"; code=$?
check "dotenv value is treated as data, not executed" 0 "$code"
if [[ -e "$marker" ]]; then
  echo "FAIL: dotenv command substitution executed"
  fail=$((fail+1))
else
  echo "PASS: dotenv command substitution did not execute"
  pass=$((pass+1))
fi

out="$(MEETSTREAM_API_BASE="http://example.com/api/v1" MEETSTREAM_TEST_MODE=1 MEETSTREAM_API_KEY=test-key "$SCRIPTS/list-agents.sh" 2>&1)"; code=$?
check "API base override rejects non-loopback host" 78 "$code"

echo
echo "== auth failure test =="
export MEETSTREAM_API_KEY="bad-key"
out="$("$SCRIPTS/list-agents.sh" 2>&1)"; code=$?
check "list-agents.sh surfaces API auth error" 1 "$code"
check_contains "list-agents.sh shows API error detail" "Invalid API key" "$out"

echo
echo "===================="
echo "passed: $pass, failed: $fail"
[[ "$fail" -eq 0 ]]
