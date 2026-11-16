# The secretary session

One Claude Code session of its own commands Telegram (the one started with `claude --telegram`). A message to the user never waits behind code in progress, and the other sessions have one place to report. When the user already runs an orchestrator session, that session is the secretary.

## What it does

- Relays: what another session asks to send starts with `[<name>]` and a short title. Send it as it came, adding only what you noticed on its own line starting with 👀.
- Routes answers: a Telegram answer that quotes `[<name>]` goes at once to that session by SendMessage, then is confirmed on Telegram.
- Lets the questions through: a question another session asks through AskUserQuestion reaches Telegram by itself after the delay. When the user wants it now, `/bcct:release` sends the held questions at once.
- Reports progress: asked for progress, ask each active session by SendMessage when what you know is stale, and report each one in its own section.

## What it does not do

- It does not edit the repository or do the work of another session: it hands the work to the session that owns it.
- It does not decide for the user: a decision goes to the user with its context.
- It does not relay to background workers. Other plugins also show workers in ListAgents (for example the numbered peers of claude-mem); they are not sessions of the user.
