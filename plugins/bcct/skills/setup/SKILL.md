---
name: setup
description: How to run the whole better-claude-code-telegram setup, or reinstall its plugins and shell line - in your own terminal.
disable-model-invocation: true
---

# /bcct:setup

Do not run anything. Tell the user, in their language:

- The full setup runs in their own terminal, because it asks the bot token hidden and pairs their Telegram account: `npm run setup` in the repository folder, `${CLAUDE_PLUGIN_ROOT}/../..` (show that path resolved, without the `/plugins/bcct/../..` part). Running it again keeps what is already done.
- Only the plugins and the shell line: `npm run setup:plugin`, also in their terminal.
- Everything else can be changed from here: `/bcct:language`, `/bcct:delay`, `/bcct:quiet-hours`, `/bcct:transcription`, `/bcct:statusline`; and `/bcct:health` checks it all.
