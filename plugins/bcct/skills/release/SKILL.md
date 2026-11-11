---
name: release
description: Send to Telegram right away the AskUserQuestion questions still waiting for the delay, from every instance or only one session.
argument-hint: "[session id prefix]"
disable-model-invocation: true
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/bcct" release *)
---

# /bcct:release

Arguments: `$ARGUMENTS`

Run `"${CLAUDE_PLUGIN_ROOT}/scripts/bcct" release $ARGUMENTS` and show its output: the questions it released, or that nothing was pending.
