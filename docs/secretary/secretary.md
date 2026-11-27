# One session for Telegram

[Português](secretary.pt-br.md)

Every Claude Code instance on the machine reaches you through the same bot. The way of working that pays off most is to keep one session of its own only for Telegram: the secretary.

## 💡 Why

- A message to you never waits behind code in progress. A session that is in the middle of an edit answers you only when it stops; the secretary answers at once.
- The other sessions have one place to report. Their questions and waiting notices still reach Telegram by themselves, and your answers go back to the session that asked, but the secretary also relays what they send, asks them for progress and hands each request to the session that owns it.
- It stays light. The secretary does not edit the repository, so its context stays free for talking to you.

## 📋 Requirements

The secretary hands requests to other sessions with the Claude Code tools `ListAgents` and `SendMessage`, so it needs a Claude Code that has cross-session messaging. Your working sessions need it too, since a session without it does not show up for the secretary: if it cannot see your other sessions, update Claude Code, then start them and `claude --telegram` again.

## 🛠 How

1. Open your working sessions as usual, one per task, with `claude`. On Telegram, each session's questions and waiting notices name it as `[<name>]`: the session's name or, when it has none, `<folder>#<start of the session id>`. Replying to a waiting notice sends your answer to the session it names.
2. Open one more with `claude --telegram`. That is the secretary: the only session with the channel on.
3. Ask for things on Telegram. The secretary sends each request to the right session and brings the answers back.

If you already run an orchestrator session, one that splits work among the others, start that one with `claude --telegram` instead: the orchestrator becomes the secretary.

## 💰 What it costs

The secretary is one more session open, with its own context. Screenshots and videos on Telegram cost more tokens; the setup asks whether you want them (`/bcct:visuals` changes it later), and whether the secretary checks each image before sending.
