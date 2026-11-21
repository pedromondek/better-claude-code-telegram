import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Browser } from "../cdp.ts";
import { MESSAGES } from "../i18n.ts";
import {
  BOARD_VIEWPORT,
  CAPTURE_SCRIPT,
  captureCommand,
  capturePage,
  FFMPEG,
  SIGNAL_EXIT_CODES,
  runAsScript,
} from "../page-capture.ts";
import {
  evaluatedValue,
  fakeCdpPage,
  type CdpResult,
  type FakeCdpPage,
} from "./support/fake-cdp-page.ts";

const EN = MESSAGES["en-us"];

let dir = "";
let page: FakeCdpPage;
let closed = 0;
let boardHtml = "";

function answer(method: string, params: CdpResult): CdpResult {
  if (method === "Runtime.evaluate") return evaluatedValue([]);

  if (method === "Page.navigate" && String(params.url).endsWith(".html")) {
    boardHtml = readFileSync(fileURLToPath(String(params.url)), "utf8");
  }

  if (method === "Page.getLayoutMetrics") {
    return {
      cssContentSize: { width: 1200, height: 900 },
      cssVisualViewport: {
        pageX: 0,
        pageY: 0,
        clientWidth: 1280,
        clientHeight: 800,
      },
    };
  }

  if (method === "Page.captureScreenshot") {
    return { data: Buffer.from("png").toString("base64") };
  }

  return {};
}

function browser(): Browser {
  return {
    newPage: (): Promise<FakeCdpPage> => Promise.resolve(page),
    close: (): Promise<void> => {
      closed += 1;

      return Promise.resolve();
    },
  };
}

function writeSpec(spec: unknown): string {
  const path = join(dir, "spec.json");

  writeFileSync(path, JSON.stringify(spec));

  return path;
}

async function run(
  input: string | undefined,
  options: Parameters<typeof capturePage>[1] = {},
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await capturePage(input, {
    messages: EN,
    chromium: () => "/cache/chrome",
    hasFfmpeg: () => true,
    runFfmpeg: () => 0,
    launch: () => Promise.resolve(browser()),
    cleanTemp: () => {
      cleaned += 1;
    },
    signals,
    exit: (exitCode) => exits.push(exitCode),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...options,
  });

  return { code, out, err };
}

const listeners = new Map<string, () => void>();
const signals = {
  once: (signal: string, listener: () => void): void => {
    listeners.set(signal, listener);
  },
  off: (signal: string, listener: () => void): void => {
    if (listeners.get(signal) === listener) listeners.delete(signal);
  },
};
let cleaned = 0;
let exits: number[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bcct-page-capture-"));
  page = fakeCdpPage(answer);
  closed = 0;
  boardHtml = "";
  cleaned = 0;
  exits = [];
  listeners.clear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("page-capture › constants", () => {
  it("draws the board 1200 px wide at 2x and runs the ffmpeg of the PATH", (): void => {
    expect(BOARD_VIEWPORT).toEqual({ width: 1200, height: 100, scale: 2 });
    expect(FFMPEG).toBe("ffmpeg");
  });

  it("runs the script with bun using its absolute path in quotes", (): void => {
    expect(captureCommand()).toBe(`bun "${CAPTURE_SCRIPT}"`);
    expect(CAPTURE_SCRIPT.endsWith("page-capture.ts")).toBe(true);
  });
});

describe("capturePage › refusals", () => {
  it("shows the usage and fails without a spec", async (): Promise<void> => {
    expect(await run(undefined)).toEqual({
      code: 1,
      out: [],
      err: [EN.captureUsage(captureCommand())],
    });
  });

  it("names what is wrong in an invalid spec", async (): Promise<void> => {
    const { code, err } = await run(writeSpec({ url: "" }));

    expect(code).toBe(1);
    expect(err).toEqual([EN.captureInvalidSpec("url must be a text")]);
  });

  it("fails with the error of a spec that cannot be read", async (): Promise<void> => {
    const { code, err } = await run(join(dir, "missing.json"));

    expect(code).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("ENOENT");
    expect(err[0].startsWith("The capture failed: Error: ENOENT")).toBe(true);
  });

  it("explains how to install the Chromium of Playwright when it is missing", async (): Promise<void> => {
    const { code, err } = await run(writeSpec({ url: "http://x/" }), {
      chromium: () => null,
    });

    expect(code).toBe(1);
    expect(err).toEqual([EN.captureMissingChromium]);
  });

  it("explains how to install ffmpeg only when the spec has a video", async (): Promise<void> => {
    const withVideo = await run(
      writeSpec({ url: "http://x/", videos: [{ name: "v", seconds: 1 }] }),
      { hasFfmpeg: () => false },
    );
    const withoutVideo = await run(writeSpec({ url: "http://x/" }), {
      hasFfmpeg: () => false,
    });

    expect(withVideo).toMatchObject({
      code: 1,
      err: [EN.captureMissingFfmpeg],
    });
    expect(withoutVideo.code).toBe(0);
  });
});

describe("capturePage › capture", () => {
  it("writes the shots and the board into the output folder, prints each path and closes the browser", async (): Promise<void> => {
    const launched: string[] = [];
    const out = join(dir, "nested", "out");
    const {
      code,
      out: printed,
      err,
    } = await run(
      writeSpec({
        url: "http://x/",
        out,
        shots: [{ name: "today" }, { name: "a" }],
        board: {
          name: "board",
          title: "Menu",
          sections: [
            { heading: "Hoje", cards: [{ shot: "today", label: "Fechado" }] },
          ],
        },
      }),
      {
        launch: (executable) => {
          launched.push(executable);

          return Promise.resolve(browser());
        },
      },
    );

    expect({ code, err }).toEqual({ code: 0, err: [] });
    expect(launched).toEqual(["/cache/chrome"]);
    expect(printed).toEqual([
      join(out, "today.png"),
      join(out, "a.png"),
      join(out, "board.png"),
    ]);
    expect(readdirSync(out).toSorted()).toEqual([
      "a.png",
      "board.png",
      "today.png",
    ]);
    expect(boardHtml).toContain(`<img src="file://${join(out, "today.png")}">`);
    expect(
      basename(
        dirname(
          fileURLToPath(
            String(
              page.calls.find(
                ([method, params]) =>
                  method === "Page.navigate" &&
                  String(params?.url).endsWith("board.html"),
              )?.[1]?.url,
            ),
          ),
        ),
      ).startsWith("bcct-board-"),
    ).toBe(true);
    expect(
      page.calls.find(
        ([method, params]) =>
          method === "Emulation.setDeviceMetricsOverride" &&
          params?.width === 1200,
      )?.[1],
    ).toEqual({
      width: 1200,
      height: 100,
      deviceScaleFactor: 2,
      mobile: false,
    });
    expect(closed).toBe(1);
    expect(
      readdirSync(tmpdir()).filter((name) => name.startsWith("bcct-board-")),
    ).toEqual([]);
  });

  it("captures the shots at the viewport and the scale of the spec", async (): Promise<void> => {
    await run(
      writeSpec({
        url: "http://x/",
        width: 390,
        height: 844,
        scale: 3,
        shots: [{ name: "phone" }],
      }),
    );

    expect(
      page.calls.find(
        ([method]) => method === "Emulation.setDeviceMetricsOverride",
      )?.[1],
    ).toEqual({
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: false,
    });
  });

  it("records each video with the ffmpeg of the options and prints the video and its sheet", async (): Promise<void> => {
    const encoded: string[][] = [];
    const { code, out } = await run(
      writeSpec({
        url: "http://x/",
        videos: [{ name: "open", seconds: 0.05, fps: 30 }],
      }),
      {
        runFfmpeg: (args) => {
          encoded.push(args);

          return 0;
        },
      },
    );

    expect(code).toBe(0);
    expect(out).toEqual([join(dir, "open.mp4"), join(dir, "open-sheet.png")]);
    expect(encoded).toHaveLength(1);
  });

  it("names the video ffmpeg could not write and still closes the browser", async (): Promise<void> => {
    const { code, err } = await run(
      writeSpec({
        url: "http://x/",
        videos: [{ name: "open", seconds: 0.05, fps: 30 }],
      }),
      { runFfmpeg: () => 1 },
    );

    expect(code).toBe(1);
    expect(err).toEqual([EN.captureFfmpegFailed(join(dir, "open.mp4"))]);
    expect(closed).toBe(1);
  });

  it("reports a failed capture and still closes the browser", async (): Promise<void> => {
    page = fakeCdpPage((method, params) =>
      method === "Page.navigate" && params.url === "http://x/"
        ? { errorText: "net::ERR_NAME_NOT_RESOLVED" }
        : answer(method, params),
    );

    const { code, err } = await run(
      writeSpec({ url: "http://x/", shots: [{ name: "today" }] }),
    );

    expect(code).toBe(1);
    expect(err).toEqual([
      EN.captureFailed("Error: http://x/: net::ERR_NAME_NOT_RESOLVED"),
    ]);
    expect(closed).toBe(1);
  });

  it("cleans the leftovers of dead runs before it starts the browser", async (): Promise<void> => {
    const order: string[] = [];

    await run(writeSpec({ url: "http://x/" }), {
      cleanTemp: () => order.push("clean"),
      launch: () => {
        order.push("launch");

        return Promise.resolve(browser());
      },
    });

    expect(order).toEqual(["clean", "launch"]);
  });

  it("closes the browser and exits with 130 on Ctrl+C or 143 on SIGTERM while it captures", async (): Promise<void> => {
    for (const [signal, exitCode] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      closed = 0;
      exits = [];

      const order: string[] = [];

      await run(writeSpec({ url: "http://x/" }), {
        launch: () =>
          Promise.resolve({
            newPage: (): Promise<FakeCdpPage> => {
              listeners.get(signal)?.();

              return Promise.resolve(page);
            },
            close: async (): Promise<void> => {
              closed += 1;
              await Promise.resolve();
              order.push("closed");
            },
          }),
        exit: (code) => {
          exits.push(code);
          order.push("exit");
        },
      });

      expect(exits).toEqual([exitCode]);
      expect(closed).toBe(2);
      expect(order.slice(0, 2)).toEqual(["closed", "exit"]);
    }
  });

  it("exits with 143 on SIGTERM even when the browser fails to close", async (): Promise<void> => {
    let closeAttempts = 0;

    await run(writeSpec({ url: "http://x/" }), {
      launch: () =>
        Promise.resolve({
          newPage: (): Promise<FakeCdpPage> => {
            listeners.get("SIGTERM")?.();

            return Promise.resolve(page);
          },
          close: (): Promise<void> => {
            closeAttempts += 1;

            return closeAttempts === 1
              ? Promise.reject(new Error("socket gone"))
              : Promise.resolve();
          },
        }),
    });

    expect(exits).toEqual([143]);
  });

  it("aborts the launch of the browser on a signal that arrives while it starts", async (): Promise<void> => {
    let launchSignal: AbortSignal | undefined;

    const { code } = await run(writeSpec({ url: "http://x/" }), {
      launch: (_executable, options) => {
        launchSignal = options.signal;
        listeners.get("SIGTERM")?.();

        return Promise.reject(new Error("Chromium stopped"));
      },
    });

    expect(launchSignal?.aborted).toBe(true);
    expect(exits).toEqual([143]);
    expect(code).toBe(1);
    expect(closed).toBe(0);
  });

  it("starts the browser with a launch that no signal aborted", async (): Promise<void> => {
    let launchSignal: AbortSignal | undefined;

    await run(writeSpec({ url: "http://x/" }), {
      launch: (_executable, options) => {
        launchSignal = options.signal;

        return Promise.resolve(browser());
      },
    });

    expect(launchSignal?.aborted).toBe(false);
    expect(exits).toEqual([]);
  });

  it("stops listening for the signals once the capture ends, with success or failure", async (): Promise<void> => {
    await run(writeSpec({ url: "http://x/" }));

    expect([...listeners.keys()]).toEqual([]);

    await run(writeSpec({ url: "http://x/" }), {
      launch: () => Promise.reject(new Error("spawn failed")),
    });

    expect([...listeners.keys()]).toEqual([]);
    expect(SIGNAL_EXIT_CODES).toEqual({ SIGINT: 130, SIGTERM: 143 });
  });

  it("exits on a signal that arrives before the browser starts", async (): Promise<void> => {
    await run(writeSpec({ url: "http://x/" }), {
      cleanTemp: () => listeners.get("SIGTERM")?.(),
    });

    expect(exits).toEqual([143]);
    expect(closed).toBe(1);
  });

  it("reports a browser that did not start, with nothing to close", async (): Promise<void> => {
    const { code, err } = await run(writeSpec({ url: "http://x/" }), {
      launch: () => Promise.reject(new Error("spawn failed")),
    });

    expect(code).toBe(1);
    expect(err).toEqual([EN.captureFailed("Error: spawn failed")]);
    expect(closed).toBe(0);
  });

  it("reports an output folder that cannot be created", async (): Promise<void> => {
    const file = join(dir, "file");

    writeFileSync(file, "x");

    const { code, err } = await run(
      writeSpec({ url: "http://x/", out: join(file, "out") }),
    );

    expect(code).toBe(1);
    expect(err[0]).toContain("ENOTDIR");
    expect(existsSync(join(file, "out"))).toBe(false);
  });
});

describe("runAsScript", () => {
  it("captures only when it is the script that bun runs, with the console and the setup language", async (): Promise<void> => {
    vi.stubEnv("BETTER_CC_TELEGRAM_DIR", dir);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await runAsScript(["bun", "/other/script.ts"]);

    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();

    await runAsScript(["bun", CAPTURE_SCRIPT]);

    expect(error).toHaveBeenCalledWith(EN.captureUsage(captureCommand()));
    expect(process.exitCode).toBe(1);
  });
});
