---
name: configure
description: Telegram channel status and how to set the bot token. Use when the user asks to configure Telegram, pastes a Telegram bot token, asks "how do I set this up" or "who can reach me," or wants to check channel status.
user-invocable: true
---

# /telegram:configure — Telegram Channel Setup

In better-claude-code-telegram the bot token never passes through Claude: it is
set only by the setup, in the user's own terminal, and Claude Code is blocked
from reading the file that holds it. Never read, write or print that file, and
never save a token given in the conversation.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status

Tell the user to run `/bcct:health telegram` for the status of the token, the
pairing and the connection, and `/bcct:health` for everything else.

### A token, or anything that looks like one — refuse to save it

BotFather tokens look like `123456789:AAH...`. Do not save it anywhere. Tell
the user, in their language:

1. That token is now in this conversation, so treat it as exposed: revoke it
   in @BotFather with `/revoke`.
2. Set the new one in their own terminal:
   `npx @pedromondek/better-claude-code-telegram token`. It is typed hidden and saved
   readable only by them.
3. Reopen `claude --telegram` afterwards.

### `clear` — remove the token

Tell the user to run `npx @pedromondek/better-claude-code-telegram uninstall` in their own
terminal to remove everything, or `npx @pedromondek/better-claude-code-telegram token` to
replace the token.
