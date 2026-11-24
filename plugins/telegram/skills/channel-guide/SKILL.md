---
name: channel-guide
description: How to talk and send on the Telegram channel of better-claude-code-telegram - decision questions and stage reports, tables as MarkdownV2 code blocks, images and videos, boards that compare today with each proposal on screenshots of the real app, and mermaid flows. Use before a decision question, a table, an image, a video or a drawing on Telegram, and in the session that commands Telegram for the other sessions.
user-invocable: false
---

# Telegram channel guide

Read only the reference of what you are about to do.

| Doing                                                          | Reference                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------ |
| Asking for a decision, reading its answer, or ending a stage   | [reference/conversation.md](reference/conversation.md)       |
| Sending a table                                                | [reference/tables.md](reference/tables.md)                   |
| Sending an image or a video                                    | [reference/images.md](reference/images.md)                   |
| Showing a visual idea, a before and after or a transition      | [reference/illustrations.md](reference/illustrations.md)     |
| Sending a flow, or something easier to read drawn              | [reference/mermaid.md](reference/mermaid.md)                 |
| Commanding Telegram for other sessions (the secretary session) | [reference/secretary.md](reference/secretary.md)             |

The scripts of this plugin print the paths of the files they write:

- Mermaid renderer: `bun "${CLAUDE_PLUGIN_ROOT}/extensions/mermaid-png.ts" <file.mmd>`.
- Page capture: `bun "${CLAUDE_PLUGIN_ROOT}/extensions/page-capture.ts" <spec.json>`.
