---
name: health
description: Check that the Telegram integration works - install, bot, pairing, token protection and extras. Asks which groups to check, or runs them all with "all".
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
   - No argument: call AskUserQuestion once, `multiSelect: true`, header "Health", asking which groups to check, with exactly these four options: `install` (Node, claude, bun, plugins, shell line), `telegram` (bot token, pairing, connection), `security` (the deny rule that keeps you from reading the token, settings), `extras` (transcription, diagrams, status line).
2. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/bcct" health --json <groups>`. A non-zero exit only means some check failed; the JSON is still on stdout.
3. Show one table: check, status (`ok`, `fail`, `off`) and detail, in the language the details come in. Then list only the `fail` rows with the fix their detail gives. `off` is an optional thing that is turned off, not a problem.

Never read files of the Telegram state folder yourself and never ask for the bot token: the token is set only with `npx better-claude-code-telegram token` in the user's own terminal.
