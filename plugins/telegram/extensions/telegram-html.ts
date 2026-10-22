export type Block =
  { kind: "text"; lines: string[] } | { kind: "pre"; lines: string[] };

const TELEGRAM_LIMIT = 4000;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const FENCE = /^\s*```/;

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function inlineMarkdown(line: string): string {
  const heading = /^#{1,6}\s+(.*)/s.exec(line);

  if (heading) return `<b>${inlineMarkdown(heading[1])}</b>`;

  return escapeHtml(line)
    .replaceAll(/`([^`]+)`/g, "<code>$1</code>")
    .replaceAll(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
}

function tableCells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) =>
      cell
        .trim()
        .replaceAll(/\*\*([^*]+)\*\*/g, "$1")
        .replaceAll(/`([^`]+)`/g, "$1"),
    );
}

export function renderTable(rows: string[]): string[] {
  const header = tableCells(rows[0]);
  const body = rows
    .slice(1)
    .filter((row) => !TABLE_SEPARATOR.test(row))
    .map(tableCells);
  const columnCount = Math.max(
    header.length,
    ...body.map((cells) => cells.length),
  );
  const widths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(
      ...[header, ...body].map((cells) => [...(cells[column] ?? "")].length),
    ),
  );
  const formatRow = (cells: string[]): string =>
    widths
      .map((width, column) => {
        const cell = cells[column] ?? "";

        return cell.padEnd(width + cell.length - [...cell].length);
      })
      .join(" │ ")
      .trimEnd();

  return [
    formatRow(header),
    widths.map((width) => "─".repeat(width)).join("─┼─"),
    ...body.map(formatRow),
  ];
}

export function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.split("\n");
  let index = 0;

  const pushText = (line: string): void => {
    const last = blocks.at(-1);

    if (last?.kind === "text") last.lines.push(line);
    else blocks.push({ kind: "text", lines: [line] });
  };

  while (index < lines.length) {
    const line = lines[index];

    if (FENCE.test(line)) {
      const code: string[] = [];

      index += 1;

      while (index < lines.length && !FENCE.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }

      blocks.push({ kind: "pre", lines: code });
      index += 1;
      continue;
    }

    if (TABLE_ROW.test(line) && TABLE_SEPARATOR.test(lines[index + 1])) {
      const rows: string[] = [];

      while (TABLE_ROW.test(lines[index])) {
        rows.push(lines[index]);
        index += 1;
      }

      blocks.push({ kind: "pre", lines: renderTable(rows) });
      continue;
    }

    pushText(line);
    index += 1;
  }

  return blocks;
}

function renderBlock(block: Block): string {
  return block.kind === "pre"
    ? `<pre>${escapeHtml(block.lines.join("\n"))}</pre>`
    : block.lines.map(inlineMarkdown).join("\n");
}

function splitOversizedBlock(block: Block, limit: number): Block[] {
  const pieces: string[][] = [];
  const maxLineLength = Math.floor(limit / 5);
  const lines = block.lines.flatMap((line) =>
    Array.from(
      { length: Math.max(1, Math.ceil(line.length / maxLineLength)) },
      (_, index) =>
        line.slice(index * maxLineLength, (index + 1) * maxLineLength),
    ),
  );

  for (const line of lines) {
    const last = pieces.at(-1);

    if (
      last !== undefined &&
      renderBlock({ kind: block.kind, lines: [...last, line] }).length <= limit
    ) {
      last.push(line);
    } else {
      pieces.push([line]);
    }
  }

  return pieces.map((pieceLines) => ({ kind: block.kind, lines: pieceLines }));
}

export function toTelegramHtmlChunks(
  markdown: string,
  limit: number = TELEGRAM_LIMIT,
): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const block of parseBlocks(markdown)) {
    const pieces =
      renderBlock(block).length > limit
        ? splitOversizedBlock(block, limit)
        : [block];

    for (const piece of pieces) {
      const html = renderBlock(piece);
      const candidate = current === "" ? html : `${current}\n${html}`;

      if (candidate.length > limit && current !== "") {
        chunks.push(current);
        current = html;
      } else {
        current = candidate;
      }
    }
  }

  if (current.trim() !== "") chunks.push(current);

  return chunks;
}
