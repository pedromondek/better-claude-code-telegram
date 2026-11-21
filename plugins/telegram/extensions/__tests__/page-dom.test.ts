import { describe, expect, it } from "vitest";

import {
  addStyle,
  areaOf,
  centerOf,
  drawOutline,
  fontsReady,
  pageCall,
  type PageRect,
  type PageScope,
} from "../page-dom.ts";

interface FakeElement {
  rect: PageRect;
  styles: Record<string, [string, string]>;
  scrolled: unknown[];
}

function fakeElement(rect: PageRect): FakeElement {
  return { rect, styles: {}, scrolled: [] };
}

function fakeScope(
  elements: Record<string, FakeElement[]>,
  scroll = { scrollX: 0, scrollY: 0 },
  page = { scrollWidth: 5000, scrollHeight: 5000 },
): PageScope & {
  appended: { textContent: string | null }[];
  created: string[];
} {
  const appended: { textContent: string | null }[] = [];
  const created: string[] = [];
  const asPageElement = (
    element: FakeElement,
  ): ReturnType<PageScope["document"]["querySelectorAll"]>[number] => ({
    style: {
      setProperty: (name, value, priority): void => {
        element.styles[name] = [value, priority];
      },
    },
    getBoundingClientRect: (): PageRect => element.rect,
    scrollIntoView: (options): void => {
      element.scrolled.push(options);
    },
  });

  return {
    appended,
    created,
    window: scroll,
    document: {
      documentElement: page,
      querySelector: (
        selector,
      ): ReturnType<PageScope["document"]["querySelector"]> => {
        const [first] = elements[selector] ?? [];

        return first ? asPageElement(first) : null;
      },
      querySelectorAll: (selector) =>
        (elements[selector] ?? []).map(asPageElement),
      createElement: (tag): { textContent: string | null } => {
        created.push(tag);

        return { textContent: null };
      },
      head: {
        append: (node): void => {
          appended.push(node);
        },
      },
      fonts: { ready: Promise.resolve("loaded") },
    },
  };
}

describe("addStyle", () => {
  it("appends a style element with the CSS of the proposal to the head", (): void => {
    const scope = fakeScope({});

    addStyle(scope, ".menu { gap: 4px }");

    expect(scope.created).toEqual(["style"]);
    expect(scope.appended).toEqual([{ textContent: ".menu { gap: 4px }" }]);
  });
});

describe("centerOf", () => {
  it("scrolls the element to the middle and returns the center of its box", (): void => {
    const menu = fakeElement({ x: 10, y: 20, width: 100, height: 40 });

    expect(centerOf(fakeScope({ "#menu": [menu] }), "#menu")).toEqual({
      x: 60,
      y: 40,
    });
    expect(menu.scrolled).toEqual([{ block: "center", inline: "center" }]);
  });

  it("returns null when no element matches", (): void => {
    expect(centerOf(fakeScope({}), "#menu")).toBeNull();
  });
});

describe("drawOutline", () => {
  it("draws the outline on every element of each selector and lists the selectors that match nothing", (): void => {
    const first = fakeElement({ x: 0, y: 0, width: 1, height: 1 });
    const second = fakeElement({ x: 0, y: 0, width: 1, height: 1 });

    expect(
      drawOutline(fakeScope({ ".item": [first, second] }), [".item", "#gone"], {
        color: "#e11d48",
        width: 4,
        offset: 3,
      }),
    ).toEqual(["#gone"]);
    expect(second.styles).toEqual({
      outline: ["4px solid #e11d48", "important"],
      "outline-offset": ["3px", "important"],
    });
    expect(first.styles).toEqual(second.styles);
  });
});

describe("areaOf", () => {
  it("returns the box of the element on the page, scrolled, with the margin around it", (): void => {
    const header = fakeElement({ x: 50, y: 30, width: 200, height: 60 });

    expect(
      areaOf(
        fakeScope({ header: [header] }, { scrollX: 5, scrollY: 100 }),
        "header",
        16,
      ),
    ).toEqual({ x: 39, y: 114, width: 232, height: 92 });
  });

  it("keeps the margin inside the page at its top left corner", (): void => {
    const header = fakeElement({ x: 4, y: 0, width: 200, height: 60 });

    expect(areaOf(fakeScope({ header: [header] }), "header", 16)).toEqual({
      x: 0,
      y: 0,
      width: 220,
      height: 76,
    });
  });

  it("keeps the margin inside the page at its bottom right corner", (): void => {
    const footer = fakeElement({ x: 0, y: 940, width: 900, height: 60 });

    expect(
      areaOf(
        fakeScope(
          { footer: [footer] },
          { scrollX: 0, scrollY: 0 },
          { scrollWidth: 900, scrollHeight: 1010 },
        ),
        "footer",
        16,
      ),
    ).toEqual({ x: 0, y: 924, width: 900, height: 86 });
  });

  it("returns null when no element matches", (): void => {
    expect(areaOf(fakeScope({}), "header", 16)).toBeNull();
  });
});

describe("fontsReady", () => {
  it("resolves true once the fonts of the page are ready", async (): Promise<void> => {
    await expect(fontsReady(fakeScope({}))).resolves.toBe(true);
  });
});

describe("pageCall", () => {
  it("calls the source of the function in the page with the document, the window and the arguments as JSON", (): void => {
    expect(pageCall(areaOf, 'a "b"', 16)).toBe(
      `(${areaOf.toString()})({ document, window }, "a \\"b\\"", 16)`,
    );
    expect(pageCall(fontsReady)).toBe(
      `(${fontsReady.toString()})({ document, window })`,
    );
  });
});
