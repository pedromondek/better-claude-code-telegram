import { describe, expect, it } from "vitest";

import { parseCaptureSpec, SpecError } from "../page-spec.ts";

const SPEC_PATH = "/work/specs/menu.json";

function parse(spec: unknown): ReturnType<typeof parseCaptureSpec> {
  return parseCaptureSpec(JSON.stringify(spec), SPEC_PATH);
}

function errorOf(spec: unknown): string {
  try {
    parse(spec);
  } catch (error) {
    if (error instanceof SpecError) return error.message;

    throw error;
  }

  throw new Error("the spec was accepted");
}

describe("parseCaptureSpec › defaults", () => {
  it("fills the viewport, the 2x scale, the output folder of the spec and empty lists", (): void => {
    expect(parse({ url: "http://localhost:3000/" })).toEqual({
      url: "http://localhost:3000/",
      out: "/work/specs",
      width: 1280,
      height: 800,
      scale: 2,
      shots: [],
      videos: [],
      board: null,
    });
  });

  it("fills each shot and video with no steps, no outline, no clip and the viewport", (): void => {
    const spec = parse({
      url: "https://app.test/",
      shots: [{ name: "today" }],
      videos: [{ name: "open", seconds: 2 }],
    });

    expect(spec.shots).toEqual([
      {
        name: "today",
        url: "https://app.test/",
        css: null,
        steps: [],
        outline: [],
        clip: null,
        fullPage: false,
      },
    ]);
    expect(spec.videos).toEqual([
      {
        name: "open",
        url: "https://app.test/",
        css: null,
        steps: [],
        outline: [],
        clip: null,
        fullPage: false,
        seconds: 2,
        fps: 12,
      },
    ]);
  });
});

describe("parseCaptureSpec › paths", () => {
  it("opens a local HTML file by its file URL, relative to the folder of the spec", (): void => {
    const spec = parse({
      url: "mock/today.html",
      out: "shots",
      shots: [{ name: "b", url: "/abs/proposal-b.html" }],
    });

    expect(spec.url).toBe("file:///work/specs/mock/today.html");
    expect(spec.out).toBe("/work/specs/shots");
    expect(spec.shots[0].url).toBe("file:///abs/proposal-b.html");
  });

  it("keeps a URL with a scheme as it is", (): void => {
    expect(parse({ url: "data:text/html,<p>x</p>" }).url).toBe(
      "data:text/html,<p>x</p>",
    );
  });
});

describe("parseCaptureSpec › shots", () => {
  it("keeps the steps, the CSS of a proposal, one or many outlines, the clip and the full page", (): void => {
    const [shot] = parse({
      url: "http://x/",
      width: 390,
      height: 844,
      scale: 3,
      shots: [
        {
          name: "proposal-a",
          css: ".menu { gap: 4px }",
          steps: [
            { hover: "#menu" },
            { click: "#menu" },
            { wait: 300 },
            { script: "window.scrollTo(0, 10)" },
          ],
          outline: "#menu",
          clip: "header",
          fullPage: true,
        },
      ],
    }).shots;

    expect(shot).toMatchObject({
      css: ".menu { gap: 4px }",
      steps: [
        { hover: "#menu" },
        { click: "#menu" },
        { wait: 300 },
        { script: "window.scrollTo(0, 10)" },
      ],
      outline: ["#menu"],
      clip: "header",
      fullPage: true,
    });
    expect(
      parse({ url: "http://x/", shots: [{ name: "a", outline: ["a", "b"] }] })
        .shots[0].outline,
    ).toEqual(["a", "b"]);
  });

  it.each([
    [{}, "url must be a text"],
    [{ url: "" }, "url must be a text"],
    [{ url: "http://x/", width: 0 }, "width must be a positive number"],
    [{ url: "http://x/", scale: "2" }, "scale must be a positive number"],
    [{ url: "http://x/", out: 1 }, "out must be a text"],
    [{ url: "http://x/", shots: {} }, "shots must be a list"],
    [{ url: "http://x/", shots: [1] }, "shots[0] must be an object"],
    [{ url: "http://x/", shots: [{}] }, "shots[0].name must be a text"],
    [
      { url: "http://x/", shots: [{ name: "../up" }] },
      "shots[0].name must use only letters, digits, - and _",
    ],
    [
      { url: "http://x/", shots: [{ name: "a" }, { name: "a" }] },
      "shots[1].name repeats a",
    ],
    [
      { url: "http://x/", shots: [{ name: "a", steps: [{}] }] },
      "shots[0].steps[0] must have one of click, hover, wait or script",
    ],
    [
      { url: "http://x/", shots: [{ name: "a", steps: [{ wait: -1 }] }] },
      "shots[0].steps[0].wait must be a positive number",
    ],
    [
      { url: "http://x/", shots: [{ name: "a", steps: [{ click: 1 }] }] },
      "shots[0].steps[0].click must be a text",
    ],
    [
      { url: "http://x/", shots: [{ name: "a", outline: [1] }] },
      "shots[0].outline must be a text or a list of texts",
    ],
    [
      { url: "http://x/", shots: [{ name: "a", outline: 1 }] },
      "shots[0].outline must be a text or a list of texts",
    ],
    [
      {
        url: "http://x/",
        shots: [{ name: "a", outline: { selector: "#menu" } }],
      },
      "shots[0].outline must be a text or a list of texts",
    ],
    [
      { url: "http://x/", shots: [{ name: "a", fullPage: "yes" }] },
      "shots[0].fullPage must be true or false",
    ],
    [
      { url: "http://x/", videos: [{ name: "v" }] },
      "videos[0].seconds must be a positive number",
    ],
    [
      { url: "http://x/", videos: [{ name: "v", seconds: "3" }] },
      "videos[0].seconds must be a positive number",
    ],
    [
      { url: "http://x/", videos: [{ name: "v", seconds: 2, fps: -1 }] },
      "videos[0].fps must be a positive number",
    ],
    [
      { url: "http://x/", shots: [{ name: "a", outline: "" }] },
      "shots[0].outline must be a text or a list of texts",
    ],
    [
      { url: "http://x/", shots: [{ name: "a", outline: ["#menu", ""] }] },
      "shots[0].outline must be a text or a list of texts",
    ],
    [
      { url: "http://x/", videos: [{ name: "v", seconds: 31 }] },
      "videos[0].seconds must be at most 30",
    ],
    [
      { url: "http://x/", videos: [{ name: "v", seconds: 2, fps: 61 }] },
      "videos[0].fps must be at most 30",
    ],
    [
      {
        url: "http://x/",
        shots: [{ name: "a" }],
        videos: [{ name: "a", seconds: 1 }],
      },
      "videos[0].name repeats a",
    ],
    [
      { url: "http://x/", shots: [{ name: "page" }, { name: "page-2" }] },
      "shots[1].name repeats the files of page",
    ],
    [
      { url: "http://x/", shots: [{ name: "page-2" }, { name: "page" }] },
      "shots[1].name repeats the files of page-2",
    ],
    [
      { url: "http://x/", shots: [{ name: "page" }, { name: "page-12" }] },
      "shots[1].name repeats the files of page",
    ],
    [
      { url: "http://x/", shots: [{ name: "v" }, { name: "v-sheet-3" }] },
      "shots[1].name repeats the files of v",
    ],
    [
      {
        url: "http://x/",
        shots: [{ name: "v-sheet" }],
        videos: [{ name: "v", seconds: 1 }],
      },
      "videos[0].name repeats the files of v-sheet",
    ],
  ])("refuses %j because %s", (spec, message): void => {
    expect(errorOf(spec)).toBe(message);
  });

  it("accepts names whose files never meet", (): void => {
    expect(
      parse({
        url: "http://x/",
        shots: [
          { name: "today" },
          { name: "today-open" },
          { name: "a" },
          { name: "a-closed" },
          { name: "step-1" },
          { name: "step-2" },
          { name: "page" },
          { name: "page-2-1" },
          { name: "page-sheets" },
          { name: "page-x-2" },
        ],
      }).shots.map((shot) => shot.name),
    ).toEqual([
      "today",
      "today-open",
      "a",
      "a-closed",
      "step-1",
      "step-2",
      "page",
      "page-2-1",
      "page-sheets",
      "page-x-2",
    ]);
  });

  it("refuses a file that is not JSON or not an object", (): void => {
    expect(() => parseCaptureSpec("{", SPEC_PATH)).toThrow(SpecError);
    expect(errorOf([])).toBe("the spec must be an object");
  });

  it("refuses a number too large to be finite with the positive number message", (): void => {
    expect(() =>
      parseCaptureSpec(
        '{"url":"http://x/","videos":[{"name":"v","seconds":1e999}]}',
        SPEC_PATH,
      ),
    ).toThrow("videos[0].seconds must be a positive number");
  });

  it("reports the parser message of a file that is not JSON, without its error name", (): void => {
    let parserMessage = "";

    try {
      JSON.parse("{");
    } catch (error) {
      parserMessage = error instanceof Error ? error.message : "";
    }

    expect(parserMessage).not.toBe("");
    expect(() => parseCaptureSpec("{", SPEC_PATH)).toThrow(
      new SpecError(parserMessage),
    );
  });
});

describe("parseCaptureSpec › board", () => {
  const board = {
    name: "board",
    title: "Menu do topo",
    context: "Hoje o menu esconde a busca.",
    sections: [
      {
        heading: "Hoje",
        cards: [{ shot: "today", label: "Fechado" }],
      },
      {
        heading: "(a) Busca fixa",
        effect: "A busca fica sempre à vista.",
        cards: [{ shot: "a", label: "Aberto", caption: "2x" }],
      },
    ],
  };

  it("keeps the board and fills the missing context, effect and caption", (): void => {
    expect(
      parse({
        url: "http://x/",
        shots: [{ name: "today" }, { name: "a" }],
        board: { ...board, context: undefined },
      }).board,
    ).toEqual({
      name: "board",
      title: "Menu do topo",
      context: null,
      sections: [
        {
          heading: "Hoje",
          effect: null,
          cards: [{ shot: "today", label: "Fechado", caption: null }],
        },
        {
          heading: "(a) Busca fixa",
          effect: "A busca fica sempre à vista.",
          cards: [{ shot: "a", label: "Aberto", caption: "2x" }],
        },
      ],
    });
  });

  it("refuses a card whose shot is not in the spec", (): void => {
    expect(
      errorOf({ url: "http://x/", shots: [{ name: "today" }], board }),
    ).toBe("board.sections[1].cards[0].shot names no shot: a");
  });

  it("refuses a board name already used by a shot", (): void => {
    expect(
      errorOf({
        url: "http://x/",
        shots: [{ name: "today" }, { name: "a" }, { name: "board" }],
        board,
      }),
    ).toBe("board.name repeats board");
  });

  it("refuses a board without sections", (): void => {
    expect(
      errorOf({ url: "http://x/", board: { ...board, sections: [] } }),
    ).toBe("board.sections must have at least one section");
  });
});
