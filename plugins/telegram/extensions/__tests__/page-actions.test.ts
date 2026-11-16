import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  areaOfShot,
  captureShot,
  CLIP_MARGIN_PX,
  evaluate,
  JPEG_QUALITY,
  OUTLINE,
  openShot,
  outlineShot,
  partPaths,
  runSteps,
  screenshot,
  splitArea,
  PART_MAX_HEIGHT_PX,
} from "../page-actions.ts";
import {
  addStyle,
  areaOf,
  centerOf,
  drawOutline,
  fontsReady,
  pageCall,
} from "../page-dom.ts";
import type { Shot } from "../page-spec.ts";
import {
  evaluatedValue as valueOf,
  fakeCdpPage as fakePage,
} from "./support/fake-cdp-page.ts";

const SHOT: Shot = {
  name: "today",
  url: "http://localhost:3000/",
  css: null,
  steps: [],
  outline: [],
  clip: null,
  fullPage: false,
};
const VIEWPORT = { width: 1280, height: 800, scale: 2 };

describe("page-actions › constants", () => {
  it("draws the outline in red #e11d48, 4 px wide and 4 px away, and splits parts at 2560 px", (): void => {
    expect(OUTLINE).toEqual({ color: "#e11d48", width: 4, offset: 4 });
    expect(CLIP_MARGIN_PX).toBe(16);
    expect(PART_MAX_HEIGHT_PX).toBe(2560);
    expect(JPEG_QUALITY).toBe(90);
  });
});

describe("evaluate", () => {
  it("runs the expression awaiting its promise and returns its value", async (): Promise<void> => {
    const page = fakePage(() => valueOf(3));

    await expect(evaluate(page, "1 + 2")).resolves.toBe(3);
    expect(page.calls).toEqual([
      [
        "Runtime.evaluate",
        { expression: "1 + 2", awaitPromise: true, returnByValue: true },
      ],
    ]);
  });

  it("returns undefined when the page gives no result", async (): Promise<void> => {
    await expect(evaluate(fakePage(), "void 0")).resolves.toBeUndefined();
  });

  it("throws the description of the exception the page raised, or its text", async (): Promise<void> => {
    await expect(
      evaluate(
        fakePage(() => ({
          exceptionDetails: {
            text: "Uncaught",
            exception: { description: "ReferenceError: x is not defined" },
          },
        })),
        "x",
      ),
    ).rejects.toThrow("ReferenceError: x is not defined");
    await expect(
      evaluate(
        fakePage(() => ({ exceptionDetails: { text: "Uncaught" } })),
        "x",
      ),
    ).rejects.toThrow("Uncaught");
  });
});

describe("openShot", () => {
  it("sets the viewport and scale, waits for the load and the fonts, then adds the CSS of the proposal", async (): Promise<void> => {
    const page = fakePage();

    await openShot(page, VIEWPORT, { ...SHOT, css: ".a { color: red }" });

    expect(page.calls.map(([method]) => method)).toEqual([
      "Page.enable",
      "Emulation.setDeviceMetricsOverride",
      "once Page.loadEventFired",
      "Page.navigate",
      "Runtime.evaluate",
      "Runtime.evaluate",
    ]);
    expect(page.calls[1][1]).toEqual({
      width: 1280,
      height: 800,
      deviceScaleFactor: 2,
      mobile: false,
    });
    expect(page.calls[3][1]).toEqual({ url: "http://localhost:3000/" });
    expect(page.evaluated()).toEqual([
      pageCall(fontsReady),
      pageCall(addStyle, ".a { color: red }"),
    ]);
  });

  it("adds no CSS when the shot has none", async (): Promise<void> => {
    const page = fakePage();

    await openShot(page, VIEWPORT, SHOT);

    expect(page.evaluated()).toEqual([pageCall(fontsReady)]);
  });

  it("throws the URL and the error of a navigation that failed", async (): Promise<void> => {
    const page = fakePage((method) =>
      method === "Page.navigate"
        ? { errorText: "net::ERR_CONNECTION_REFUSED" }
        : {},
    );

    await expect(openShot(page, VIEWPORT, SHOT)).rejects.toThrow(
      "http://localhost:3000/: net::ERR_CONNECTION_REFUSED",
    );
  });

  it("gives up a page that never finishes loading", async (): Promise<void> => {
    const page = {
      ...fakePage(),
      once: (): Promise<Record<string, unknown>> =>
        new Promise(() => undefined),
    };

    await expect(openShot(page, VIEWPORT, SHOT, 10)).rejects.toThrow(
      "http://localhost:3000/ did not load in 0.01 s",
    );
  });
});

describe("runSteps", () => {
  it("moves the mouse to the center of the element to hover, and also presses and releases it to click", async (): Promise<void> => {
    const page = fakePage((method) =>
      method === "Runtime.evaluate" ? valueOf({ x: 60, y: 40 }) : {},
    );

    await runSteps(page, [{ hover: "#menu" }, { click: "#save" }]);

    expect(page.evaluated()).toEqual([
      pageCall(centerOf, "#menu"),
      pageCall(centerOf, "#save"),
    ]);
    expect(
      page.calls
        .filter(([method]) => method === "Input.dispatchMouseEvent")
        .map(([, params]) => params),
    ).toEqual([
      { type: "mouseMoved", x: 60, y: 40 },
      { type: "mouseMoved", x: 60, y: 40 },
      { type: "mousePressed", x: 60, y: 40, button: "left", clickCount: 1 },
      { type: "mouseReleased", x: 60, y: 40, button: "left", clickCount: 1 },
    ]);
  });

  it("runs a script step in the page and waits the milliseconds of a wait step", async (): Promise<void> => {
    const page = fakePage();
    const started = Date.now();

    await runSteps(page, [{ script: "document.body.click()" }, { wait: 40 }]);

    expect(page.evaluated()).toEqual(["document.body.click()"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });

  it("throws when the element to click or hover is not on the page", async (): Promise<void> => {
    const page = fakePage(() => valueOf(null));

    await expect(runSteps(page, [{ click: "#gone" }])).rejects.toThrow(
      "no element matches #gone",
    );
    await expect(
      runSteps(
        fakePage(() => valueOf({ x: 1 })),
        [{ hover: "#half" }],
      ),
    ).rejects.toThrow("no element matches #half");
  });
});

describe("outlineShot", () => {
  it("draws the red outline on the selectors of the shot", async (): Promise<void> => {
    const page = fakePage(() => valueOf([]));

    await outlineShot(page, ["#menu", ".item"]);

    expect(page.evaluated()).toEqual([
      pageCall(drawOutline, ["#menu", ".item"], OUTLINE),
    ]);
  });

  it("does nothing without selectors", async (): Promise<void> => {
    const page = fakePage();

    await outlineShot(page, []);

    expect(page.calls).toEqual([]);
  });

  it("throws the selectors that matched no element", async (): Promise<void> => {
    await expect(
      outlineShot(
        fakePage(() => valueOf(["#a", "#b"])),
        ["#a", "#b", "#c"],
      ),
    ).rejects.toThrow("no element matches #a, #b");
    await expect(
      outlineShot(
        fakePage(() => valueOf("not a list")),
        ["#a"],
      ),
    ).resolves.toBeUndefined();
  });
});

describe("areaOfShot", () => {
  const METRICS = {
    cssContentSize: { x: 0, y: 0, width: 1280, height: 4000 },
    cssVisualViewport: {
      pageX: 0,
      pageY: 300,
      clientWidth: 1280,
      clientHeight: 800,
    },
  };

  it("measures the clip element with its margin", async (): Promise<void> => {
    const area = { x: 10, y: 20, width: 300, height: 90 };
    const page = fakePage(() => valueOf(area));

    await expect(
      areaOfShot(page, { ...SHOT, clip: "header" }),
    ).resolves.toEqual(area);
    expect(page.evaluated()).toEqual([
      pageCall(areaOf, "header", CLIP_MARGIN_PX),
    ]);
  });

  it("throws when the clip element is not on the page", async (): Promise<void> => {
    await expect(
      areaOfShot(
        fakePage(() => valueOf(null)),
        { ...SHOT, clip: "header" },
      ),
    ).rejects.toThrow("no element matches header");
    await expect(
      areaOfShot(
        fakePage(() => valueOf({ x: 1, y: 2, width: 3 })),
        {
          ...SHOT,
          clip: "header",
        },
      ),
    ).rejects.toThrow("no element matches header");
  });

  it("takes the whole page for a full page shot and the visible part otherwise", async (): Promise<void> => {
    const page = fakePage(() => METRICS);

    await expect(
      areaOfShot(page, { ...SHOT, fullPage: true }),
    ).resolves.toEqual({ x: 0, y: 0, width: 1280, height: 4000 });
    await expect(areaOfShot(page, SHOT)).resolves.toEqual({
      x: 0,
      y: 300,
      width: 1280,
      height: 800,
    });
    expect(page.calls.map(([method]) => method)).toEqual([
      "Page.getLayoutMetrics",
      "Page.getLayoutMetrics",
    ]);
  });
});

describe("splitArea", () => {
  it("keeps an area within 2560 px at the scale in one part", (): void => {
    const area = { x: 5, y: 10, width: 600, height: 1280 };

    expect(splitArea(area, 2)).toEqual([area]);
  });

  it("splits a tall area into equal parts of at most 2560 px at the scale", (): void => {
    expect(splitArea({ x: 0, y: 100, width: 600, height: 3000 }, 2)).toEqual([
      { x: 0, y: 100, width: 600, height: 1000 },
      { x: 0, y: 1100, width: 600, height: 1000 },
      { x: 0, y: 2100, width: 600, height: 1000 },
    ]);
    expect(splitArea({ x: 0, y: 0, width: 600, height: 2561 }, 1)).toEqual([
      { x: 0, y: 0, width: 600, height: 1281 },
      { x: 0, y: 1281, width: 600, height: 1280 },
    ]);
  });

  it("keeps one part for an empty area", (): void => {
    expect(splitArea({ x: 0, y: 0, width: 600, height: 0 }, 2)).toHaveLength(1);
  });
});

describe("screenshot", () => {
  it("captures the area beyond the viewport as PNG, or as JPEG at quality 90", async (): Promise<void> => {
    const page = fakePage(() => ({
      data: Buffer.from("image-bytes").toString("base64"),
    }));
    const area = { x: 1, y: 2, width: 3, height: 4 };

    expect(String(await screenshot(page, area, "png"))).toBe("image-bytes");
    await screenshot(page, area, "jpeg");

    expect(page.calls).toEqual([
      [
        "Page.captureScreenshot",
        {
          format: "png",
          clip: { ...area, scale: 1 },
          captureBeyondViewport: true,
        },
      ],
      [
        "Page.captureScreenshot",
        {
          format: "jpeg",
          quality: 90,
          clip: { ...area, scale: 1 },
          captureBeyondViewport: true,
        },
      ],
    ]);
  });
});

describe("partPaths", () => {
  it("names a single part after the shot and numbers the parts of a split one", (): void => {
    expect(partPaths("/out", "today", 1)).toEqual(["/out/today.png"]);
    expect(partPaths("/out", "today", 2)).toEqual([
      "/out/today-1.png",
      "/out/today-2.png",
    ]);
  });
});

describe("captureShot", () => {
  let out = "";

  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), "bcct-capture-out-"));
  });

  afterEach(() => {
    rmSync(out, { recursive: true, force: true });
  });

  it("opens the page, runs the steps, draws the outline and writes each part of the area", async (): Promise<void> => {
    let shots = 0;
    const page = fakePage((method, params) => {
      if (method === "Runtime.evaluate") {
        return String(params.expression).includes("centerOf")
          ? valueOf({ x: 1, y: 1 })
          : valueOf([]);
      }

      if (method === "Page.getLayoutMetrics") {
        return { cssContentSize: { width: 800, height: 2000 } };
      }

      if (method === "Page.captureScreenshot") {
        shots += 1;

        return { data: Buffer.from(`part ${shots}`).toString("base64") };
      }

      return {};
    });

    const paths = await captureShot(
      page,
      VIEWPORT,
      {
        ...SHOT,
        steps: [{ click: "#menu" }],
        outline: [".list"],
        fullPage: true,
      },
      out,
    );

    expect(paths).toEqual([join(out, "today-1.png"), join(out, "today-2.png")]);
    expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual([
      "part 1",
      "part 2",
    ]);
    expect(page.evaluated()).toEqual([
      pageCall(fontsReady),
      pageCall(centerOf, "#menu"),
      pageCall(drawOutline, [".list"], OUTLINE),
    ]);
    expect(
      page.calls
        .filter(([method]) => method === "Page.captureScreenshot")
        .map(([, params]) => params?.format),
    ).toEqual(["png", "png"]);
  });
});
