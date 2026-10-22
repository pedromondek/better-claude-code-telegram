PROGRESS_FRAMES='|/-\'
PROGRESS_BAR_WIDTH=20

progress_columns() {
  columns=$(stty size </dev/tty 2>/dev/null | cut -d' ' -f2)
  case "$columns" in
    '' | *[!0-9]*) columns=${COLUMNS:-80} ;;
  esac
  echo "$columns"
}

progress_duration() {
  if [ "$1" -lt 60 ]; then
    printf '%ss' "$1"
  else
    printf '%sm%02ds' $(($1 / 60)) $(($1 % 60))
  fi
}

progress_count_line() {
  finished=$1
  total=$2
  elapsed=$3
  estimate=${4:-estimate}
  case "$finished" in '' | *[!0-9]*) return 0 ;; esac
  case "$total" in '' | *[!0-9]*) return 0 ;; esac
  [ "$total" -gt 0 ] || return 0
  [ "$finished" -le "$total" ] || finished=$total
  filled=$((finished * PROGRESS_BAR_WIDTH / total))
  bar=$(printf "%${filled}s" '' | tr ' ' '=')$(printf "%$((PROGRESS_BAR_WIDTH - filled))s" '')
  printf '(%s/%s) %s%% [%s] 100%% • %s' "$finished" "$total" $((finished * 100 / total)) "$bar" "$(progress_duration "$elapsed")"
  if [ "$estimate" != "no-estimate" ] && [ "$finished" -gt 0 ] && [ "$finished" -lt "$total" ]; then
    printf ' / ~%s left' "$(progress_duration $((elapsed * (total - finished) / finished)))"
  fi
}

progress_count() {
  count_file=$1
  [ -n "$count_file" ] && [ -s "$count_file" ] || return 0
  count_finished=''
  count_total=''
  read -r count_finished count_total 2>/dev/null <"$count_file"
  progress_count_line "$count_finished" "$count_total" "$2" "$3"
}

progress_result() {
  result=$(progress_count "$1" "$2" no-estimate)
  [ -n "$result" ] && printf ' %s' "$result"
  return 0
}

progress_live() {
  step_pid=$1
  step_msg=$2
  owner_pid=$3
  step_file=$4
  started=$(date +%s)
  frame_index=0
  while kill -0 "$step_pid" 2>/dev/null && kill -0 "$owner_pid" 2>/dev/null; do
    frame_index=$(((frame_index % 4) + 1))
    frame=$(printf '%s' "$PROGRESS_FRAMES" | cut -c"$frame_index")
    count=$(progress_count "$step_file" $(($(date +%s) - started)))
    if [ -n "$count" ]; then
      status=$count
    else
      status=$(ps -o etime= -p "$step_pid" 2>/dev/null | tr -d ' ')
    fi
    printf '\r\033[2K%.*s' "$(($(progress_columns) - 1))" "$frame $step_msg $status"
    sleep 0.2 >/dev/null 2>&1
  done
}

progress_heartbeat() {
  step_pid=$1
  step_msg=$2
  owner_pid=$3
  step_file=$4
  interval=${PROGRESS_HEARTBEAT_SECONDS:-10}
  waited=0
  while sleep 1 >/dev/null 2>&1 && kill -0 "$step_pid" 2>/dev/null && kill -0 "$owner_pid" 2>/dev/null; do
    waited=$((waited + 1))
    [ $((waited % interval)) -eq 0 ] || continue
    count=$(progress_count "$step_file" "$waited")
    if [ -n "$count" ]; then
      printf '%s %s %s\n' '…' "$step_msg" "$count"
    else
      printf '%s %s %ss\n' '…' "$step_msg" "$waited"
    fi
  done
}

wait_step() {
  pid=$1
  msg=$2
  file=$3
  step_started=$(date +%s)
  if [ -t 1 ]; then
    progress_live "$pid" "$msg" "$$" "$file" &
  else
    printf '%s %s\n' '→' "$msg"
    progress_heartbeat "$pid" "$msg" "$$" "$file" &
  fi
  progress_ticker=$!
  if wait "$pid"; then progress_code=0; else progress_code=$?; fi
  progress_elapsed=$(($(date +%s) - step_started))
  kill "$progress_ticker" 2>/dev/null
  wait "$progress_ticker" 2>/dev/null
  [ -t 1 ] && printf '\r\033[2K%s %s\n' '→' "$msg"
  return "$progress_code"
}
