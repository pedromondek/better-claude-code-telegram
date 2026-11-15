---
name: token
description: How to set or change the Telegram bot token - in your own terminal, so the token never passes through Claude.
disable-model-invocation: true
---

# /bcct:token

Do not run anything and never ask for the token. Tell the user, in their language:

- The token is set only in their own terminal, outside Claude Code, so it never enters this conversation: `npx @pedromondek/better-claude-code-telegram token`. The token is typed hidden and saved readable only by them, and Claude Code is blocked from reading that file.
- After changing it, reopen `claude --telegram`.
- If they already pasted a token in this conversation, that token is exposed: revoke it in @BotFather (`/revoke`), then set the new one with the command above.
