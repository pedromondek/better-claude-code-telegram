#!/usr/bin/env sh

mise_bin=$(command -v mise 2>/dev/null)

if [ -z "$mise_bin" ] && [ -x "$HOME/.local/bin/mise" ]; then
  mise_bin="$HOME/.local/bin/mise"
fi

if [ -z "$mise_bin" ]; then
  printf '%s\n' \
    "✖ $1 runs through mise, which is not installed." \
    "  Install it (https://mise.jdx.dev/installing-mise.html), then run in this repository: mise trust && mise install" >&2
  exit 1
fi

exec "$mise_bin" exec -- "$@"
