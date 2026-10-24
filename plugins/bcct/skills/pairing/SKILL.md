---
name: pairing
description: How to pair or change the Telegram account that talks to the bot - in your own terminal, with a one-time code.
disable-model-invocation: true
---

# /bcct:pairing

Do not run anything and never approve a pairing yourself. Tell the user, in their language:

- Pairing runs in their own terminal: `npm run setup:pairing` in the repository folder, `${CLAUDE_PLUGIN_ROOT}/../..` (show that path resolved, without the `/plugins/bcct/../..` part).
- It shows a one-time code and a `t.me` link; only the Telegram account that opens the link or sends that code within 3 minutes is paired, after they confirm it in the terminal. The bot talks to that one account only.
- Close `claude --telegram` before pairing, and reopen it afterwards.
