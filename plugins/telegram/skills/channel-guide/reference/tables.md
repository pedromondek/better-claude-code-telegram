# Tables on Telegram

Telegram does not render markdown tables. Send a table when it helps, as aligned columns inside a ``` code block:

- columns separated by `│`;
- a `─┼─` line under the header, as the terminal shows it;
- the reply sent with `format: "markdownv2"`.

In MarkdownV2, escape the special characters outside code blocks, and only ` and \ inside them.

Example:

```
Item  │ State
──────┼──────
Setup │ done
Tests │ red
```
