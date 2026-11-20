import { describe, expect, it } from "vitest";

import {
  escapeHtml,
  parseBlocks,
  renderTable,
  toTelegramHtmlChunks,
} from "../telegram-html.ts";

const TABLE = [
  "| Do `.tar` | Aqui |",
  "|---|---|",
  "| Escuta sempre ligada | O canal entrega |",
  "| **Botões** | ok |",
];

describe("escapeHtml", () => {
  it("escapes the three characters Telegram HTML requires", (): void => {
    expect(escapeHtml("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
  });
});

describe("renderTable", () => {
  it("aligns the columns like the terminal table, without markdown markup", (): void => {
    expect(renderTable(TABLE)).toEqual([
      "Do .tar              │ Aqui",
      "─────────────────────┼────────────────",
      "Escuta sempre ligada │ O canal entrega",
      "Botões               │ ok",
    ]);
  });

  it("pads a row that has fewer cells", (): void => {
    expect(renderTable(["| A | B |", "|---|---|", "| x |"])).toEqual([
      "A │ B",
      "──┼──",
      "x │",
    ]);
  });

  it("reads an indented table like one at the margin", (): void => {
    expect(renderTable(["  | A | B |", "  |---|---|", "  | x | y |"])).toEqual([
      "A │ B",
      "──┼──",
      "x │ y",
    ]);
  });

  it("reads rows without the outer pipes", (): void => {
    expect(renderTable(["A | B", "--|--", "x | y"])).toEqual([
      "A │ B",
      "──┼──",
      "x │ y",
    ]);
  });
});

describe("parseBlocks", () => {
  it("splits text, table and code block into kinds", (): void => {
    const blocks = parseBlocks(
      ["Antes", ...TABLE, "Meio", "```", "const x = 1;", "```", "Depois"].join(
        "\n",
      ),
    );

    expect(blocks.map((block) => block.kind)).toEqual([
      "text",
      "pre",
      "text",
      "pre",
      "text",
    ]);
    expect(blocks[3].lines).toEqual(["const x = 1;"]);
  });

  it("keeps a line with a pipe that is not a table as text", (): void => {
    expect(parseBlocks("| solto |").map((block) => block.kind)).toEqual([
      "text",
    ]);
  });

  it("keeps consecutive text lines in one block", (): void => {
    expect(parseBlocks("Antes\nDepois")).toEqual([
      { kind: "text", lines: ["Antes", "Depois"] },
    ]);
  });

  it("takes the rest as code when the fence never closes", (): void => {
    expect(parseBlocks("Antes\n```\nconst x = 1;\nconst y = 2;")).toEqual([
      { kind: "text", lines: ["Antes"] },
      { kind: "pre", lines: ["const x = 1;", "const y = 2;"] },
    ]);
  });

  it("keeps a horizontal rule under a text line as text", (): void => {
    expect(parseBlocks("Texto\n---")).toEqual([
      { kind: "text", lines: ["Texto", "---"] },
    ]);
  });
});

describe("toTelegramHtmlChunks", () => {
  it("converts bold, code and heading and escapes the rest", (): void => {
    expect(
      toTelegramHtmlChunks("## Título\n**Feito** com `npm ci` & <ok>"),
    ).toEqual([
      "<b>Título</b>\n<b>Feito</b> com <code>npm ci</code> &amp; &lt;ok&gt;",
    ]);
  });

  it("keeps the asterisks of a code span out of the bold that follows it", (): void => {
    expect(
      toTelegramHtmlChunks("Ignore `node_modules/**` in **every** config"),
    ).toEqual(["Ignore <code>node_modules/**</code> in <b>every</b> config"]);
  });

  it("keeps the asterisks of two code spans on one line as code", (): void => {
    expect(
      toTelegramHtmlChunks("**Run `npm ci`** then `src/**/a` and `lib/**/b`"),
    ).toEqual([
      "<b>Run <code>npm ci</code></b> then <code>src/**/a</code> and <code>lib/**/b</code>",
    ]);
  });

  it("keeps the digits outside a code span", (): void => {
    expect(toTelegramHtmlChunks("Step 2 of 3: `npm ci` and **go**")).toEqual([
      "Step 2 of 3: <code>npm ci</code> and <b>go</b>",
    ]);
  });

  it("keeps a private use placeholder typed in the text as typed", (): void => {
    expect(toTelegramHtmlChunks("a \u{E000}7\u{E001} b")).toEqual([
      "a \u{E000}7\u{E001} b",
    ]);
  });

  it("puts the table in a monospaced block", (): void => {
    const [html] = toTelegramHtmlChunks(TABLE.join("\n"));

    expect(html.startsWith("<pre>Do .tar")).toBe(true);
    expect(html.endsWith("ok</pre>")).toBe(true);
  });

  it("splits without cutting a tag, each part of a long block in its own pre", (): void => {
    const code = Array.from({ length: 600 }, (_, index) => `linha ${index}`);
    const chunks = toTelegramHtmlChunks(
      ["Intro", "```", ...code, "```"].join("\n"),
      1000,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1000)).toBe(true);
    expect(
      chunks.every(
        (chunk) => chunk.split("<pre>").length === chunk.split("</pre>").length,
      ),
    ).toBe(true);
    expect(chunks.join("\n").split("linha ").length - 1).toBe(600);
  });

  it("splits a single line longer than the limit", (): void => {
    const chunks = toTelegramHtmlChunks("x".repeat(5000), 1000);

    expect(chunks.every((chunk) => chunk.length <= 1000)).toBe(true);
    expect(chunks.join("").split("x").length - 1).toBe(5000);
  });

  it("keeps whole each line that fits alone when the block is over the limit", (): void => {
    const lines = ["a", "b", "c", "d", "e", "f"].map((letter) =>
      letter.repeat(300),
    );

    expect(toTelegramHtmlChunks(lines.join("\n"), 1000)).toEqual([
      lines.slice(0, 3).join("\n"),
      lines.slice(3).join("\n"),
    ]);
  });

  it("splits a long line of astral characters without breaking a surrogate pair", (): void => {
    const line = `a${"😀".repeat(2500)}`;
    const chunks = toTelegramHtmlChunks(line, 1000);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.isWellFormed())).toBe(true);
    expect(chunks.every((chunk) => chunk.length <= 1000)).toBe(true);
    expect(chunks.join("").replaceAll("\n", "")).toBe(line);
  });

  it("only takes a heading at the start of the line, after the spaces", (): void => {
    expect(toTelegramHtmlChunks("##  Título\nUse C# ou F# aqui")).toEqual([
      "<b>Título</b>\nUse C# ou F# aqui",
    ]);
  });

  it("renders a heading that ends in a carriage return", (): void => {
    expect(toTelegramHtmlChunks("## Título\r\nCorpo")).toEqual([
      "<b>Título\r</b>\nCorpo",
    ]);
  });

  it("keeps the line breaks of a code block and joins small blocks in one message", (): void => {
    expect(
      toTelegramHtmlChunks("Antes\n```\nconst a = 1;\nconst b = 2;\n```"),
    ).toEqual(["Antes\n<pre>const a = 1;\nconst b = 2;</pre>"]);
  });

  it("joins two blocks that land exactly on the limit", (): void => {
    expect(toTelegramHtmlChunks("abcdefg\n```\nx\n```", 20)).toEqual([
      "abcdefg\n<pre>x</pre>",
    ]);
  });

  it("keeps a block that lands exactly on the limit whole", (): void => {
    expect(toTelegramHtmlChunks("x".repeat(50), 50)).toEqual(["x".repeat(50)]);
  });

  it("fills each part of a long code block up to the limit", (): void => {
    const code = [
      "a".repeat(10),
      "a".repeat(10),
      "a".repeat(10),
      "c".repeat(6),
    ];

    expect(
      toTelegramHtmlChunks(["```", ...code, "b", "```"].join("\n"), 50),
    ).toEqual([`<pre>${code.join("\n")}</pre>`, "<pre>b</pre>"]);
  });

  it("keeps the empty lines of a long text block", (): void => {
    const lines = [
      "a".repeat(10),
      "",
      "b".repeat(10),
      "",
      "c".repeat(10),
      "d".repeat(10),
    ];

    expect(
      toTelegramHtmlChunks([...lines, "e".repeat(10)].join("\n"), 50),
    ).toEqual([lines.join("\n"), "e".repeat(10)]);
  });

  it("sends a line that only passes the limit after escaping whole, with no empty message", (): void => {
    expect(
      toTelegramHtmlChunks(`\`\`\`\n${"&".repeat(10)}\n\`\`\``, 50),
    ).toEqual([`<pre>${"&amp;".repeat(10)}</pre>`]);
  });

  it("sends nothing for blank markdown", (): void => {
    expect(toTelegramHtmlChunks("")).toEqual([]);
    expect(toTelegramHtmlChunks(" \n  ")).toEqual([]);
  });
});
