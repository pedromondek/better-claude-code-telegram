export interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PagePoint {
  x: number;
  y: number;
}

export interface OutlineStyle {
  color: string;
  width: number;
  offset: number;
}

interface PageElement {
  style: {
    setProperty: (name: string, value: string, priority: string) => void;
  };
  getBoundingClientRect: () => PageRect;
  scrollIntoView: (options: { block: string; inline: string }) => void;
}

export interface PageScope {
  document: {
    documentElement: { scrollWidth: number; scrollHeight: number };
    querySelector: (selector: string) => PageElement | null;
    querySelectorAll: (selector: string) => PageElement[];
    createElement: (tag: "style") => { textContent: string | null };
    head: { append: (node: { textContent: string | null }) => void };
    fonts: { ready: Promise<unknown> };
  };
  window: { scrollX: number; scrollY: number };
}

export function addStyle({ document }: PageScope, css: string): void {
  const style = document.createElement("style");

  style.textContent = css;
  document.head.append(style);
}

export function centerOf(
  { document }: PageScope,
  selector: string,
): PagePoint | null {
  const element = document.querySelector(selector);

  if (!element) return null;

  element.scrollIntoView({ block: "center", inline: "center" });

  const rect = element.getBoundingClientRect();

  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export function drawOutline(
  { document }: PageScope,
  selectors: string[],
  outline: OutlineStyle,
): string[] {
  return selectors.filter((selector) => {
    const elements = Array.from(document.querySelectorAll(selector));

    for (const element of elements) {
      element.style.setProperty(
        "outline",
        `${outline.width}px solid ${outline.color}`,
        "important",
      );
      element.style.setProperty(
        "outline-offset",
        `${outline.offset}px`,
        "important",
      );
    }

    return elements.length === 0;
  });
}

export function areaOf(
  { document, window }: PageScope,
  selector: string,
  margin: number,
): PageRect | null {
  const element = document.querySelector(selector);

  if (!element) return null;

  const rect = element.getBoundingClientRect();
  const left = rect.x + window.scrollX;
  const top = rect.y + window.scrollY;
  const { scrollWidth, scrollHeight } = document.documentElement;
  const x = Math.max(0, left - margin);
  const y = Math.max(0, top - margin);

  return {
    x,
    y,
    width: Math.min(scrollWidth, left + rect.width + margin) - x,
    height: Math.min(scrollHeight, top + rect.height + margin) - y,
  };
}

export function fontsReady({ document }: PageScope): Promise<boolean> {
  return document.fonts.ready.then(() => true);
}

export function pageCall<TArgs extends unknown[]>(
  pageFunction: (scope: PageScope, ...args: TArgs) => unknown,
  ...args: TArgs
): string {
  const values = args.map((arg) => `, ${JSON.stringify(arg)}`).join("");

  return `(${pageFunction.toString()})({ document, window }${values})`;
}
