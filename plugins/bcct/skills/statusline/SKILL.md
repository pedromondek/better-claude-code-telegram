---
name: statusline
description: Show the Telegram indicator in the Claude Code status line, alone, after the status line you already have or fitted into it by Claude, or take it out.
argument-hint: "[on | after | replace | custom | off]"
disable-model-invocation: true
allowed-tools:
  - AskUserQuestion
  - Bash(sh "${CLAUDE_PLUGIN_ROOT}/../../scripts/bcct.sh" setup *)
---

# /bcct:statusline

Current setup: !`sh "${CLAUDE_PLUGIN_ROOT}/../../scripts/bcct.sh" setup --show`

Arguments: `$ARGUMENTS`

The `statusline` field says what is there now: `none`, `ours`, `ours-after` (ours after the user's own), `other` (only the user's own), `custom-pending` (the user's own, with a request for Claude to fit the indicator into it) or `custom` (the user's own, with the indicator Claude fitted into it).

1. If the arguments name `on`, `after`, `replace`, `custom` or `off`, use it. Otherwise call AskUserQuestion once, header "Status line":
   - `none`: options `on` (show the indicator) and keep it off.
   - `other`, `custom-pending` or `custom`: options `after` (keep yours and add the indicator after it), `replace` (use only the indicator; your settings.json is backed up first), `custom` (Claude fits the indicator into yours, the way you want) and keep yours as it is.
   - `ours` or `ours-after`: options keep it and `off` (take it out; your previous status line comes back).
2. For `custom`, do it in this session: run `sh "${CLAUDE_PLUGIN_ROOT}/../../scripts/bcct.sh" setup --set statusline custom`, then `sh "${CLAUDE_PLUGIN_ROOT}/../../scripts/bcct.sh" setup --statusline-prompt --take`, and follow the request it prints as if the user had sent it.
3. For any other choice, unless the user chose to keep things as they are, run `sh "${CLAUDE_PLUGIN_ROOT}/../../scripts/bcct.sh" setup --set statusline <value>` and show its output. The status line updates on the next refresh.
