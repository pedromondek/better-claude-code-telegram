---
name: delay
description: Change how many minutes without an answer in the terminal take your messages, questions and permission requests to Telegram.
argument-hint: "[minutes]"
disable-model-invocation: true
allowed-tools:
  - AskUserQuestion
  - Bash(sh "${CLAUDE_PLUGIN_ROOT}/../../scripts/bcct.sh" setup *)
---

# /bcct:delay

Current setup: !`sh "${CLAUDE_PLUGIN_ROOT}/../../scripts/bcct.sh" setup --show`

Arguments: `$ARGUMENTS`

1. If the arguments carry a number of minutes greater than 0, use it. Otherwise call AskUserQuestion once, header "Delay", with four options taken from 1, 3, 4, 5, 10 and 15 minutes: the current value (`delayMinutes`) first and marked as current, 4 minutes marked "(Recommended)", and the nearest others; the user can type another number.
2. Run `sh "${CLAUDE_PLUGIN_ROOT}/../../scripts/bcct.sh" setup --set delay <minutes>` and show its output. It applies to the next messages.
