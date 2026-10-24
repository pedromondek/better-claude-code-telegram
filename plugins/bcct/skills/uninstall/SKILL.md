---
name: uninstall
description: How to remove better-claude-code-telegram from this machine - in your own terminal.
disable-model-invocation: true
---

# /bcct:uninstall

Do not run anything. Tell the user, in their language:

- Close every `claude --telegram`, then run `npm run uninstall` in their own terminal, in the repository folder `${CLAUDE_PLUGIN_ROOT}/../..` (show that path resolved, without the `/plugins/bcct/../..` part).
- It removes the shell line, the status line indicator (bringing back their previous one), the deny rule, the plugins and the marketplace, and asks before deleting the bot token, the pairing and the settings.
- Afterwards the repository folder can be deleted.
