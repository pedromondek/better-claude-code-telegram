---
name: inbox
description: Change how many days the photos and files received on Telegram are kept before being deleted, or keep them forever.
argument-hint: "[days | off]"
disable-model-invocation: true
allowed-tools:
  - AskUserQuestion
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/bcct" setup *)
---

# /bcct:inbox

Current setup: !`"${CLAUDE_PLUGIN_ROOT}/scripts/bcct" setup --show`

Arguments: `$ARGUMENTS`

1. If the arguments carry a number of days greater than 0 or `off`, use it. Otherwise call AskUserQuestion once, header "Inbox", with the options 1, 7 and 30 days and `off` (keep them forever), the current value (`inboxRetentionDays`, or off when it is null) first and marked as current; the user can type another number.
2. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/bcct" setup --set inbox <value>` and show its output. The cleanup runs when `claude --telegram` starts and every hour while it is open.
