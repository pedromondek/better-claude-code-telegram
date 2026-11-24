---
name: delay
description: Change how many minutes without an answer in the terminal take your messages, questions and permission requests to Telegram, one delay for all or one per kind.
argument-hint: "[minutes | per kind | reminder [minutes]]"
disable-model-invocation: true
allowed-tools:
  - AskUserQuestion
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/bcct" setup *)
---

# /bcct:delay

Current setup: !`"${CLAUDE_PLUGIN_ROOT}/scripts/bcct" setup --show`

Arguments: `$ARGUMENTS`

1. If the arguments say `reminder` or `lembrete`, with or without minutes, go to step 5. Otherwise, if the arguments carry a number of minutes, 0 or more (decimals allowed, 0 means right away), go to step 3 with it. If they say per kind (`per kind`, `por tipo`) or carry three numbers like `0/4/10`, go to step 4.
2. Otherwise call AskUserQuestion once, header "Delay", with four options, one of them "Per kind…", with the kinds in its description: "questions, permission requests and waiting notice", or their current values when `delays` is set, such as "questions right away · permission requests 4 min · waiting notice 10 min". The other three come from "Right away (0)", 1, 3, 4, 5, 10 and 15 minutes: the current value (`delayMinutes`) first and marked as current when `delays` is null (otherwise "Per kind…" is the current one), 4 minutes marked "(Recommended)", and the nearest others. Show a delay under a minute in seconds ("30 s") and from a minute on in minutes and the seconds left ("2 min 30 s" for 2.5). The user can type another number.
3. A number: run `"${CLAUDE_PLUGIN_ROOT}/scripts/bcct" setup --set delay <minutes>` and show its output. A single delay also turns the delay per kind off, and three equal kinds are saved as that single delay.
4. Per kind: call AskUserQuestion once with three questions, headers "Questions", "Permissions" and "Waiting", each asking the minutes for that kind, where 0 means right away. Offer "Right away (0)", the current value of that kind marked as current, and two of 1, 4 and 10 minutes; the user can type another number. Then run `"${CLAUDE_PLUGIN_ROOT}/scripts/bcct" setup --set delays <questions>/<permissions>/<waiting>` and show its output.

5. Reminder: the minutes a multi-select question with options marked can sit untouched on Telegram before the reminder to conclude it (3 by default, 0 means right away, and it never follows the delay above); moving on to another question or message sends the reminder at once. With minutes, run `"${CLAUDE_PLUGIN_ROOT}/scripts/bcct" setup --set reminder <minutes>` and show its output. Without them, call AskUserQuestion once, header "Reminder", with four options: "Right away (0)", 3 minutes marked "(Recommended)", the current value (`reminder`) marked as current, and the nearest others from 1, 5 and 10 minutes to fill the four; the user can type another number. Then run the same command. Changing the delay, single or per kind, keeps the reminder.

It applies to the next messages; nothing to reopen.
