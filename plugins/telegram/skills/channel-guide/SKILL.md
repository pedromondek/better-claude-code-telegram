---
name: channel-guide
description: How to send a table, an image, a video or a diagram on the Telegram channel of better-claude-code-telegram - tables as MarkdownV2 code blocks, checking and ordering images and videos, and mermaid flows rendered to PNG. Use before replying on Telegram with a table, an image or a video, and when a flow is easier to understand drawn.
user-invocable: false
---

# Telegram channel guide

Read only the reference of what you are about to send.

| Sending                                     | Reference                                    |
| ------------------------------------------- | -------------------------------------------- |
| A table                                     | [reference/tables.md](reference/tables.md)   |
| An image or a video                         | [reference/images.md](reference/images.md)   |
| A flow, or something easier to read drawn   | [reference/mermaid.md](reference/mermaid.md) |

The mermaid renderer of this plugin is `bun "${CLAUDE_PLUGIN_ROOT}/extensions/mermaid-png.ts" <file.mmd>`: it prints the path of the PNG it wrote.
