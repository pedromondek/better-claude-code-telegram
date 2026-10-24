---
name: language
description: Change the language of the Telegram messages and of the setup (en-us or pt-br).
argument-hint: "[en-us | pt-br]"
disable-model-invocation: true
allowed-tools:
  - AskUserQuestion
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/../../scripts/setup.mjs" *)
---

# /bcct:language

Current setup: !`node "${CLAUDE_PLUGIN_ROOT}/../../scripts/setup.mjs" --show`

Arguments: `$ARGUMENTS`

1. If the arguments name `en-us` or `pt-br`, use it. Otherwise call AskUserQuestion once, header "Language", with the options "English / Inglês (en-us)" and "Português Brasileiro / Brazilian Portuguese (pt-br)", the current one first and marked as current.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/../../scripts/setup.mjs" --set language <value>` and show its output. It applies to the next messages; nothing to reopen.
