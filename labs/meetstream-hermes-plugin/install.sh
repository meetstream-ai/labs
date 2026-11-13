#!/bin/sh
set -eu

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
hermes_root=${HERMES_HOME:-"$HOME/.hermes"}
target="$hermes_root/skills/meetstream"

if [ -e "$target" ]; then
  echo "Refusing to overwrite existing installation: $target" >&2
  exit 1
fi

mkdir -p "$(dirname -- "$target")"
cp -R "$source_dir" "$target"
echo "Installed MeetStream plugin at $target"
echo "Next: cd $target/bridge && npm install && npm run setup"
