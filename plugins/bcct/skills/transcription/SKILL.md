---
name: transcription
description: Turn the local transcription of Telegram voice messages on or off, or change its model (base, small, medium).
argument-hint: "[base | small | medium | off]"
disable-model-invocation: true
allowed-tools:
  - AskUserQuestion
  - Bash(sh "${CLAUDE_PLUGIN_ROOT}/../../scripts/bcct.sh" setup *)
---

# /bcct:transcription

Current setup: !`sh "${CLAUDE_PLUGIN_ROOT}/../../scripts/bcct.sh" setup --show`

Arguments: `$ARGUMENTS`

1. If the arguments name `base`, `small`, `medium` or `off`, use it. Otherwise call AskUserQuestion once, header "Transcription", with the options `base` (fastest, uses the least RAM, fine for clear speech, ~150 MB of storage; the default), `small` (more accurate, slower, uses more RAM, ~490 MB of storage), `medium` (most accurate, much slower, uses much more RAM, ~1.5 GB of storage) and `off`, the current value (`transcription`, or off when it is null) first and marked as current.
2. Run `sh "${CLAUDE_PLUGIN_ROOT}/../../scripts/bcct.sh" setup --set transcription <value>` and show its output. Turning it on may create the Python environment and download the model, which takes a few minutes; if it asks to install `uv`, tell the user to run `npm run setup:transcription` in their own terminal instead, where they can answer.
