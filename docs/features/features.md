# ✨ Features

Every feature the releases shipped, as their notes describe it. The release writes this file from `docs/releases` with `npm run docs:features`; the [versioning](../versioning/versioning.md) doc has the flow.

## 💬 Telegram channel

- ✨ **Answer from Telegram.** Claude's questions arrive as **buttons** on your phone; one tap answers in the terminal.

  No more walking back to the computer to unblock a session.

  [▶ Demo](https://github.com/user-attachments/assets/442d10cb-1232-48e8-afd5-456e80c2bbec)

- ✨ **Know when Claude is waiting.** If Claude waits for you for a few minutes, Telegram tells you, with its **last message**.

  When it stops on the **usage limit** or an API error, a card says why and when it comes back.

  [▶ Demo](https://github.com/user-attachments/assets/3c17844e-b294-4641-9b75-f3be59fcf3c6)

- ✨ **Every session, one bot.** Run **several Claude Code sessions** and talk to all of them through one bot.

  Each message carries the **name of its session**, so you always know who is asking.

  [▶ Demo](https://github.com/user-attachments/assets/f725460d-430e-4d29-8244-3e7a7f9becc0)

- ✨ **Tables that read.** When Claude answers with a table, it arrives on Telegram as **aligned columns**, not a wall of pipes.

  Long messages go on in the next ones, with bold and code kept.

  [▶ Demo](https://github.com/user-attachments/assets/83e335e0-1e7e-4d5e-8d65-2d0c6a4d242c)

- ✨ **See the idea before it is built.** With illustrations on, Claude shows a **visual idea** as a board, today next to each proposal, and asks which one to build.

  [▶ Demo](https://github.com/user-attachments/assets/3f255fbf-af1a-42bd-9648-3418268acd8a)

- ✨ **Allow or deny from your phone.** Permission requests arrive with **See more**, **Allow** and **Deny** buttons, held back while you are active in the terminal.

  [▶ Demo](https://github.com/user-attachments/assets/7a21427e-378b-4c07-9183-b585b0dce7f8)

- ✨ **Messages when you want them.** Choose a **delay**, one for all or one per kind, and **quiet hours** that hold the messages; `bcct release` sends what is held right away.

- ✨ **A nudge for unfinished choices.** A multiple-choice question with options marked but no Done gets **one reminder**, as a reply to it.

- ✨ **Your language.** Messages in **English or Brazilian Portuguese**, chosen in the setup.

## 🎙️ Voice transcription

- ✨ **Talk instead of typing.** Send a **voice message**; it is transcribed **on your machine** and reaches Claude as text.

  Nothing goes to a transcription service.

  [▶ Demo](https://github.com/user-attachments/assets/05bd103d-83de-418f-950c-e2c7ca763f1f)

## 🧰 Setup, health and update

- ✨ **Set up in one command.** `npx @pedromondek/better-claude-code-telegram` walks you through the language, the bot token and the pairing.

  It checks everything at the end, and each step runs again on its own (`bcct setup delay`) or from the `/bcct:` commands.

  [▶ Demo](https://github.com/user-attachments/assets/a39fe9f0-8622-4136-bbb2-00b6b5aa108d)

- ✨ **Telegram only when you ask.** `claude --telegram` opens the session with Telegram, and plain `claude` keeps working as before; `/resume` switches conversations without turning it off.

- ✨ **Check and repair.** `bcct health` checks the install, the bot, the pairing and the token protection, and `bcct health --fix` repairs what it can.

- ✨ **Update and remove cleanly.** `bcct update` updates the plugins and the binary, showing what changes and asking first; `bcct uninstall` removes only what the setup added.

- ✨ **Linux, macOS and Windows.** Linux and macOS on x64 and arm64, and native Windows with basic support.

## 📊 Status line

- ✨ **Telegram, right in your status line.** An optional indicator shows whether Telegram is **connected, connecting or down**.

  [▶ Demo](https://github.com/user-attachments/assets/d78c548f-73f3-4c88-834d-ea7e06ca1322)
