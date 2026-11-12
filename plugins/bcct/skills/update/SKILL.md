---
name: update
description: Update the plugins and the bcct binary to the newest release, or to the channel or version given. Shows what would change and asks before applying.
argument-hint: "[stable | beta | alpha | <version>]"
disable-model-invocation: true
allowed-tools:
  - AskUserQuestion
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/bcct" update *)
---

# /bcct:update

Arguments: `$ARGUMENTS`

1. Take the target from the arguments: `stable`, `beta`, `alpha` or a version such as `0.3.0`. Anything else: say the usage is `/bcct:update [stable | beta | alpha | <version>]` and stop.
2. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/bcct" update <target> --check`, without `<target>` when there is none. It changes nothing. Read its last line:
   - Already on a version, or a line with ✘: show it and stop.
   - Would update from one version to another: call AskUserQuestion once, header "Update", with two options: `update` (Recommended), description the line itself, and `not now`, which changes nothing.
   - On a test version, with a list of `'bcct update <channel>' (<version>)` commands: call AskUserQuestion once, header "Channel", with one option per command in the order they come, the first one marked (Recommended): label = the channel, description = its version. Add a last option `not now`.
3. If the user picked `not now`, stop. Otherwise run `"${CLAUDE_PLUGIN_ROOT}/scripts/bcct" update <target>`, with the target of step 1 or the picked channel, and show its output. A non-zero exit means it stopped on the line with ✘: show that line and the fix it gives.
4. After an update that went through, say it applies to new Claude Code sessions and that this one needs `/reload-plugins`.
