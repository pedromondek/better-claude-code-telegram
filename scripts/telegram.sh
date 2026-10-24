#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"

node -r "$root_dir/scripts/require-node.cjs" "$root_dir/scripts/setup.mjs" --check "$@" || exit 1

export BETTER_CC_TELEGRAM=1

node -r "$root_dir/scripts/require-node.cjs" "$root_dir/scripts/setup.mjs" --mark-launch || true

first_prompt=()
only_flags=1

for arg in "$@"; do
  case "$arg" in
    -*) ;;
    *) only_flags=0 ;;
  esac
done

if [ "$only_flags" -eq 1 ]; then
  request="$(node -r "$root_dir/scripts/require-node.cjs" "$root_dir/scripts/setup.mjs" --statusline-prompt --take || true)"

  if [ -n "$request" ]; then
    first_prompt=("$request")
  fi
fi

exec claude --name telegram ${first_prompt[@]+"${first_prompt[@]}"} \
  --settings '{"enabledPlugins":{"telegram@better-claude-code-telegram":true}}' \
  --dangerously-load-development-channels plugin:telegram@better-claude-code-telegram "$@"
