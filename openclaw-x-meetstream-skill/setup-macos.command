#!/usr/bin/env bash
# Double-click installer for macOS Finder.

cd "$(dirname "$0")" || exit 1
chmod +x install.sh scripts/*.sh tests/run_tests.sh

echo "MeetStream for OpenClaw"
echo "======================="
echo
bash ./install.sh
status=$?

echo
if [[ "$status" -eq 0 ]]; then
  echo "Setup finished successfully. You can close this window."
  echo "Open OpenClaw and say: Show me the MIA agents I can use."
else
  echo "Setup stopped with an error. Keep this window open and review the message above."
fi
echo
read -r -p "Press Return to close..." _
exit "$status"
