---
name: visuals
description: Choose whether Claude illustrates ideas on Telegram with screenshots of the real app, today next to each proposal with the area in red, and transition videos, and whether it checks each image before sending. Both cost more tokens.
argument-hint: "[off | prints | video] [review | direct]"
disable-model-invocation: true
allowed-tools:
  - AskUserQuestion
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/bcct" setup *)
---

# /bcct:visuals

Current setup: !`"${CLAUDE_PLUGIN_ROOT}/scripts/bcct" setup --show`

Arguments: `$ARGUMENTS`

1. If the arguments name the illustrations (`off`, `prints` or `video`), use them. Otherwise call AskUserQuestion with the question "Illustrations on Telegram", header "Illustrations", saying that they cost more tokens, with the options off, screenshots only (today next to each proposal, the area in red) and screenshots and transition video; the current value (`visuals`) first and marked as current.
2. With `prints` or `video`, if the arguments do not say `review` or `direct`, ask in the same AskUserQuestion call (or right after, when step 1 was answered by the arguments) "Review before sending", header "Review", with "Claude checks each image before sending (more tokens)" and "Send directly", the current value (`visualReview`) first and marked as current.
3. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/bcct" setup --set visuals <off|prints|video>` and, when step 2 was answered, `"${CLAUDE_PLUGIN_ROOT}/scripts/bcct" setup --set visual-review <on|off>` (`on` for review). Show their output, including any warning about a missing Chromium of Playwright or ffmpeg.
4. The channel reads the choice when `claude --telegram` starts or its channel reconnects (`/mcp reconnect plugin:telegram:telegram` in that session). In this session, follow the new choice from now on.
