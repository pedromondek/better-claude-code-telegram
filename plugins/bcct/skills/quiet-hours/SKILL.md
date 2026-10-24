---
name: quiet-hours
description: Change the quiet hours, when nothing goes to Telegram, or turn them off.
argument-hint: "[HH:MM-HH:MM | off]"
disable-model-invocation: true
allowed-tools:
  - AskUserQuestion
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/../../scripts/setup.mjs" *)
---

# /bcct:quiet-hours

Current setup: !`node "${CLAUDE_PLUGIN_ROOT}/../../scripts/setup.mjs" --show`

Arguments: `$ARGUMENTS`

1. If the arguments carry an interval like `22:00-08:00` or `off`, use it. Otherwise call AskUserQuestion once, header "Quiet hours", with four options taken from off, outside business hours `18:00-08:00`, all night `18:00-07:00`, night `22:00-07:00` and small hours `00:00-07:00`, each name with its hours: the current value (`quietHours`, or off when it is null) first and marked as current; the user can type another interval.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/../../scripts/setup.mjs" --set quiet-hours <value>` and show its output.
