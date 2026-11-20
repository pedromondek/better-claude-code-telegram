---
name: health
description: Check that the Telegram integration works - install, bot, pairing, token protection and extras - and offer to fix what bcct can repair on its own. Asks which groups to check, or runs them all with "all".
argument-hint: "[all | install | telegram | security | extras]"
disable-model-invocation: true
allowed-tools:
  - AskUserQuestion
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/bcct" health *)
---

# /bcct:health

Arguments: `$ARGUMENTS`

1. Decide the groups:
   - `all` or `tudo` in the arguments: every group.
   - One or more of `install`, `telegram`, `security`, `extras`: those groups.
   - No argument: call AskUserQuestion once, header "Health", with two options: "All (Recommended)", which checks every group, and "Choose groups". Only after "Choose groups", call AskUserQuestion again, `multiSelect: true`, header "Groups", asking which groups to check, with exactly these four options: `install` (claude, bun, git, plugins, launcher, binary and plugin versions, shell line, bcct on PATH, app folder, hook warnings), `telegram` (bot token, bot kept out of groups, pairing, connection), `security` (not running as root, the deny rule that keeps you from reading the token, settings), `extras` (transcription, diagrams, illustrations: Chromium and ffmpeg, status line).
2. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/bcct" health --json --fix <groups>`. A non-zero exit only means some check failed; the JSON is still on stdout: `results` (the checks) and `fixes.available` (what bcct can repair on its own).
3. Show one table from `results`: check, status (`ok`, `fail`, `off`) and detail, in the language the details come in. Then list only the `fail` rows with the fix their detail gives. `off` is an optional thing that is turned off, not a problem.
4. If `fixes.available` is empty, stop. Otherwise call AskUserQuestion once, `multiSelect: true`, header "Fix", asking which ones to apply, with one option per available fix: label = its `check`, description = its `action`. When there is only one, add a second option `none` that applies nothing.
5. If the user picked any fix, run `"${CLAUDE_PLUGIN_ROOT}/scripts/bcct" health --json --fix --only <ids> <groups>` with the picked `id`s joined by commas, then show the new table from `results` and say what `fixes.applied` holds and each `fixes.skipped` with its reason.

Never read files of the Telegram state folder yourself and never ask for the bot token: the token is set only with `npx @pedromondek/better-claude-code-telegram token` in the user's own terminal.
