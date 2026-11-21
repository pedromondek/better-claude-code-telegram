import { describe, expect, it } from "vitest";

import { boardHtml, escapeHtml, SECTION_COLORS } from "../page-board.ts";
import type { Board } from "../page-spec.ts";

const BOARD: Board = {
  name: "board",
  title: "Menu <do> topo",
  context: "Hoje o menu esconde a busca.",
  sections: [
    {
      heading: "Hoje",
      effect: null,
      cards: [{ shot: "today", label: "Fechado", caption: null }],
    },
    {
      heading: "(a) Busca fixa",
      effect: "A busca fica sempre à vista.",
      cards: [
        { shot: "a-closed", label: "Fechado", caption: "De perto, 2x" },
        { shot: "a-open", label: "Aberto", caption: null },
      ],
    },
  ],
};

const IMAGES = new Map([
  ["today", ["/out/today.png"]],
  ["a-closed", ["/out/a closed.png"]],
  ["a-open", ["/out/a-open-1.png", "/out/a-open-2.png"]],
]);

describe("escapeHtml", () => {
  it("escapes the five characters that open markup in text and attributes", (): void => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});

describe("SECTION_COLORS", () => {
  it("keeps gray for today and leaves the red of the outline out of the proposals", (): void => {
    expect(SECTION_COLORS).toEqual([
      "#64748b",
      "#2563eb",
      "#16a34a",
      "#9333ea",
      "#ea580c",
      "#0891b2",
    ]);
    expect(SECTION_COLORS).not.toContain("#e11d48");
  });
});

describe("boardHtml", () => {
  const html = boardHtml(BOARD, IMAGES);

  it("opens with the escaped title and the context", (): void => {
    expect(html).toContain(
      '<h1>Menu &lt;do&gt; topo</h1><p class="context">Hoje o menu esconde a busca.</p>',
    );
  });

  it("gives each section its color, its heading and the sentence of its effect", (): void => {
    expect(html).toContain(
      '<section style="--color: #64748b"><h2>Hoje</h2><div class="cards">',
    );
    expect(html).toContain(
      '<section style="--color: #2563eb"><h2>(a) Busca fixa</h2><p class="effect">A busca fica sempre à vista.</p><div class="cards">',
    );
  });

  it("shows each card with its label, every part of its shot by file URL and its caption", (): void => {
    expect(html).toContain(
      '<figure><p class="label">Fechado</p><img src="file:///out/a%20closed.png"><figcaption>De perto, 2x</figcaption></figure>',
    );
    expect(html).toContain(
      '<figure><p class="label">Aberto</p><img src="file:///out/a-open-1.png"><img src="file:///out/a-open-2.png"></figure>',
    );
  });

  it("is a full UTF-8 page with its own styles", (): void => {
    expect(
      html.startsWith(
        '<!doctype html><html><head><meta charset="utf-8"><style>',
      ),
    ).toBe(true);
    expect(html.endsWith("</body></html>")).toBe(true);
    expect(html).toContain("border-left: 6px solid var(--color)");
    expect(html).toContain(
      "figure { margin: 0; flex: 0 1 calc(50% - 8px); min-width: 240px }",
    );
  });

  it("leaves out the context and cycles the proposal colors past the last one", (): void => {
    const sections = Array.from({ length: 7 }, (_, index) => ({
      heading: `s${index}`,
      effect: null,
      cards: [],
    }));
    const cycled = boardHtml({ ...BOARD, context: null, sections }, IMAGES);

    expect(cycled).not.toContain('class="context"');
    expect(cycled).toContain("</h1><section");
    expect(cycled).toContain('<section style="--color: #0891b2"><h2>s5</h2>');
    expect(cycled).toContain('<section style="--color: #2563eb"><h2>s6</h2>');
  });

  it("shows a card without images when its shot wrote none", (): void => {
    expect(
      boardHtml(
        {
          ...BOARD,
          sections: [
            {
              heading: "Hoje",
              effect: null,
              cards: [{ shot: "missing", label: "X", caption: null }],
            },
          ],
        },
        new Map(),
      ),
    ).toContain('<figure><p class="label">X</p></figure>');
  });
});
