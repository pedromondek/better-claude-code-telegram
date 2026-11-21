_better_cc_telegram_launcher="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/bcct.sh"

claude() {
  local wants_telegram=0
  local arg
  local -a claude_args=()

  for arg in "$@"; do
    if [ "$arg" = "--telegram" ]; then
      wants_telegram=1
    else
      claude_args+=("$arg")
    fi
  done

  if [ "$wants_telegram" -eq 0 ]; then
    command claude "$@"
    return
  fi

  sh "$_better_cc_telegram_launcher" launch "${claude_args[@]}"
}
