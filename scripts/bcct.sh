#!/usr/bin/env sh

for candidate in \
  "${BETTER_CC_TELEGRAM_BIN:-}" \
  "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/better-claude-code-telegram/bin/bcct" \
  bcct; do
  [ -n "$candidate" ] || continue
  version=$("$candidate" --version </dev/null 2>/dev/null) || continue

  case "$version" in
    "bcct "*) exec "$candidate" "$@" ;;
  esac
done

root_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
subcommand=${1:-}

[ "$#" -eq 0 ] || shift

case "$subcommand" in
  hook) exec node "$root_dir/plugins/telegram-hooks/hooks/telegram.mjs" "$@" ;;
  statusline) exec node "$root_dir/plugins/telegram-hooks/statusline.mjs" "$@" ;;
  release) exec node "$root_dir/scripts/release.mjs" "$@" ;;
  health) exec node "$root_dir/scripts/health.mjs" "$@" ;;
  setup) exec node "$root_dir/scripts/setup.mjs" "$@" ;;
  uninstall) exec node "$root_dir/scripts/setup.mjs" --uninstall "$@" ;;
  launch) exec bash "$root_dir/scripts/telegram.sh" "$@" ;;
esac

printf '%s\n' "bcct: no binary found and no JavaScript fallback for '$subcommand'" >&2
exit 2
