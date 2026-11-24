import { pathToFileURL } from "node:url";

import type { Board, BoardCard, BoardSection } from "./page-spec.ts";

export const SECTION_COLORS = [
  "#64748b",
  "#2563eb",
  "#16a34a",
  "#9333ea",
  "#ea580c",
  "#0891b2",
] as const;

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const BOARD_STYLE = [
  'body { margin: 0; padding: 32px; background: #fff; color: #0f172a; font: 16px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif }',
  "h1 { margin: 0 0 4px; font-size: 26px }",
  ".context { margin: 0 0 24px; color: #475569 }",
  "section { margin: 0 0 28px; padding-left: 14px; border-left: 6px solid var(--color) }",
  "h2 { margin: 0 0 4px; font-size: 20px; color: var(--color) }",
  ".effect { margin: 0 0 12px; color: #334155 }",
  ".cards { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start }",
  "figure { margin: 0; flex: 0 1 calc(50% - 8px); min-width: 240px }",
  ".label { margin: 0 0 6px; font-weight: 600 }",
  "img { display: block; max-width: 100%; border: 1px solid #cbd5e1; border-radius: 6px }",
  "figcaption { margin-top: 6px; color: #475569; font-size: 14px }",
].join("\n");

export function escapeHtml(text: string): string {
  return text.replaceAll(/[&<>"']/g, (character) => HTML_ENTITIES[character]);
}

function colorOf(index: number): string {
  const [today, ...proposals] = SECTION_COLORS;

  return index === 0 ? today : proposals[(index - 1) % proposals.length];
}

function cardHtml(card: BoardCard, images: Map<string, string[]>): string {
  const pictures = (images.get(card.shot) ?? [])
    .map((path) => `<img src="${pathToFileURL(path).href}">`)
    .join("");
  const caption =
    card.caption === null
      ? ""
      : `<figcaption>${escapeHtml(card.caption)}</figcaption>`;

  return `<figure><p class="label">${escapeHtml(card.label)}</p>${pictures}${caption}</figure>`;
}

function sectionHtml(
  section: BoardSection,
  index: number,
  images: Map<string, string[]>,
): string {
  const effect =
    section.effect === null
      ? ""
      : `<p class="effect">${escapeHtml(section.effect)}</p>`;
  const cards = section.cards.map((card) => cardHtml(card, images)).join("");

  return `<section style="--color: ${colorOf(index)}"><h2>${escapeHtml(section.heading)}</h2>${effect}<div class="cards">${cards}</div></section>`;
}

export function boardHtml(board: Board, images: Map<string, string[]>): string {
  const context =
    board.context === null
      ? ""
      : `<p class="context">${escapeHtml(board.context)}</p>`;
  const sections = board.sections
    .map((section, index) => sectionHtml(section, index, images))
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><style>${BOARD_STYLE}</style></head><body><h1>${escapeHtml(board.title)}</h1>${context}${sections}</body></html>`;
}
