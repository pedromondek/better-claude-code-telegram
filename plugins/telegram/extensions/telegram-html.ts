export type Block =
  | { kind: "text"; lines: string[] }
  | { kind: "pre"; lines: string[] }
  | { kind: "quote"; lines: string[] };

const TELEGRAM_LIMIT = 4000;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const FENCE = /^\s*```/;
const QUOTE_LINE = /^ {0,3}> ?(.*)/s;
const CODE_SPAN = /`([^`]+)`/y;
const CODE_PLACEHOLDER = /\u{E000}(\d+)\u{E001}/gu;
const ESCAPABLE = /^[!-/:-@[-`{-~]$/;

interface Literal {
  text: string;
  isCode: boolean;
}

interface ScannedInline {
  marked: string;
  literals: Literal[];
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function scanInline(line: string): ScannedInline {
  const literals: Literal[] = [];
  let marked = "";
  let index = 0;

  const hold = (literal: Literal): void => {
    literals.push(literal);
    marked += `\u{E000}${literals.length - 1}\u{E001}`;
  };

  while (index < line.length) {
    const char = line[index];
    const next = line.charAt(index + 1);

    if (char === "\\" && ESCAPABLE.test(next)) {
      hold({ text: next, isCode: false });
      index += 2;
      continue;
    }

    CODE_SPAN.lastIndex = index;

    const codeSpan = CODE_SPAN.exec(line);

    if (codeSpan) {
      hold({ text: codeSpan[1], isCode: true });
      index += codeSpan[0].length;
      continue;
    }

    marked += char;
    index += 1;
  }

  return { marked, literals };
}

function restoreLiterals(
  marked: string,
  literals: Literal[],
  render: (literal: Literal) => string,
): string {
  return marked.replaceAll(
    CODE_PLACEHOLDER,
    (match: string, index: string): string => {
      const literal = literals.at(Number(index));

      return literal === undefined ? match : render(literal);
    },
  );
}

function inlineMarkdown(line: string): string {
  const heading = /^#{1,6}\s+(.*)/s.exec(line);

  if (heading) return `<b>${inlineMarkdown(heading[1])}</b>`;

  const { marked, literals } = scanInline(line);

  return restoreLiterals(
    escapeHtml(marked).replaceAll(/\*\*([^*]+)\*\*/g, "<b>$1</b>"),
    literals,
    ({ text, isCode }) =>
      isCode ? `<code>${escapeHtml(text)}</code>` : escapeHtml(text),
  );
}

function splitCells(row: string): string[] {
  const cells: string[] = [];
  let current = "";
  let index = 0;

  while (index < row.length) {
    const char = row[index];

    if (char === "\\" && ESCAPABLE.test(row.charAt(index + 1))) {
      current += row[index + 1] === "|" ? "|" : `${char}${row[index + 1]}`;
      index += 2;
      continue;
    }

    if (char === "|") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }

    index += 1;
  }

  cells.push(current);

  return cells;
}

function tableCells(row: string): string[] {
  const trimmed = row.trim();
  const cells = splitCells(trimmed);

  if (trimmed.startsWith("|")) cells.shift();

  if (cells.at(-1) === "") cells.pop();

  return cells.map((cell) => {
    const { marked, literals } = scanInline(cell.trim());

    return restoreLiterals(
      marked.replaceAll(/\*\*([^*]+)\*\*/g, "$1"),
      literals,
      ({ text }) => text,
    );
  });
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

  const pushLine = (kind: "text" | "quote", line: string): void => {
    const last = blocks.at(-1);

    if (last?.kind === kind) last.lines.push(line);
    else blocks.push({ kind, lines: [line] });
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

      if (code.some((codeLine) => codeLine.trim() !== "")) {
        blocks.push({ kind: "pre", lines: code });
      }

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

    const quoted = QUOTE_LINE.exec(line);

    if (quoted) pushLine("quote", quoted[1]);
    else pushLine("text", line);

    index += 1;
  }

  return blocks.filter(
    (block) =>
      block.kind !== "quote" || block.lines.some((line) => line.trim() !== ""),
  );
}

function renderBlock(block: Block): string {
  if (block.kind === "pre") {
    return `<pre>${escapeHtml(block.lines.join("\n"))}</pre>`;
  }

  const html = block.lines.map(inlineMarkdown).join("\n");

  return block.kind === "quote" ? `<blockquote>${html}</blockquote>` : html;
}

function renderedLineLength(kind: Block["kind"], line: string): number {
  return (kind === "pre" ? escapeHtml(line) : inlineMarkdown(line)).length;
}

function splitBlockToLimit(block: Block, limit: number): Block[] {
  const pieces: string[][] = [];
  const maxLineLength = Math.floor(limit / 5);
  const wrapperLength = renderBlock({ kind: block.kind, lines: [] }).length;
  const lines = block.lines.flatMap((line) => {
    if (wrapperLength + renderedLineLength(block.kind, line) <= limit) {
      return [line];
    }

    const codePoints = [...line];

    return Array.from(
      { length: Math.ceil(codePoints.length / maxLineLength) },
      (_, index) =>
        codePoints
          .slice(index * maxLineLength, (index + 1) * maxLineLength)
          .join(""),
    );
  });

  let pieceLength = 0;

  for (const line of lines) {
    const last = pieces.at(-1);
    const lineLength = renderedLineLength(block.kind, line);

    if (last !== undefined && pieceLength + 1 + lineLength <= limit) {
      last.push(line);
      pieceLength += 1 + lineLength;
    } else {
      pieces.push([line]);
      pieceLength = wrapperLength + lineLength;
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
    for (const piece of splitBlockToLimit(block, limit)) {
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
