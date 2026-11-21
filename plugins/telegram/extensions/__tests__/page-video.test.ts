import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OUTLINE } from "../page-actions.ts";
import { centerOf, drawOutline, pageCall } from "../page-dom.ts";
import type { VideoShot } from "../page-spec.ts";
import {
  FfmpegError,
  ffmpegArgs,
  FRAME_PATTERN,
  frameSheetHtml,
  LEAD_IN_MS,
  pickSheetFrames,
  recordVideo,
  SHEET_FRAMES,
  SHEET_VIEWPORT,
  type Frame,
} from "../page-video.ts";
import {
  evaluatedValue,
  fakeCdpPage,
  type CdpResult,
  type FakeCdpPage,
} from "./support/fake-cdp-page.ts";

const VIDEO: VideoShot = {
  name: "open-menu",
  url: "http://localhost:3000/",
  css: null,
  steps: [{ click: "#menu" }],
  outline: ["#menu"],
  clip: null,
  fullPage: false,
  seconds: 1,
  fps: 4,
};
const VIEWPORT = { width: 640, height: 360, scale: 2 };

function frames(count: number): Frame[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `/frames/frame-${index}.jpg`,
    atMs: index * 100,
  }));
}

describe("page-video › constants", () => {
  it("leads in half a second, checks 6 frames on a 1200 px sheet and numbers the frames in four digits", (): void => {
    expect(LEAD_IN_MS).toBe(500);
    expect(SHEET_FRAMES).toBe(6);
    expect(SHEET_VIEWPORT).toEqual({ width: 1200, height: 100, scale: 1 });
    expect(FRAME_PATTERN).toBe("frame-%04d.jpg");
  });
});

describe("ffmpegArgs", () => {
  it("encodes the frames at the measured rate as H.264 with even sides, yuv420p and the index first", (): void => {
    expect(ffmpegArgs("/frames", 11.11111, "/out/open.mp4")).toEqual([
      "-y",
      "-loglevel",
      "error",
      "-framerate",
      "11.111",
      "-i",
      "/frames/frame-%04d.jpg",
      "-vf",
      "scale=trunc(iw/2)*2:trunc(ih/2)*2:out_range=tv,format=yuv420p",
      "-c:v",
      "libx264",
      "-movflags",
      "+faststart",
      "/out/open.mp4",
    ]);
  });
});

describe("pickSheetFrames", () => {
  it("keeps every frame of a video with 6 or fewer", (): void => {
    expect(pickSheetFrames(frames(6))).toEqual(frames(6));
  });

  it("keeps every frame of a video with fewer than 6", (): void => {
    expect(pickSheetFrames(frames(3))).toEqual(frames(3));
    expect(pickSheetFrames(frames(1))).toEqual(frames(1));
    expect(pickSheetFrames(frames(0))).toEqual([]);
  });

  it("spreads 6 frames from the first to the last", (): void => {
    expect(pickSheetFrames(frames(11)).map(({ atMs }) => atMs)).toEqual([
      0, 200, 400, 600, 800, 1000,
    ]);
    expect(pickSheetFrames(frames(7)).map(({ atMs }) => atMs)).toEqual([
      0, 100, 200, 400, 500, 600,
    ]);
  });
});

describe("frameSheetHtml", () => {
  it("shows each frame by file URL with its time in seconds", (): void => {
    const html = frameSheetHtml([
      { path: "/frames/a b.jpg", atMs: 0 },
      { path: "/frames/c.jpg", atMs: 1250 },
    ]);

    expect(html).toContain(
      '<figure><img src="file:///frames/a%20b.jpg"><figcaption>0.0 s</figcaption></figure><figure><img src="file:///frames/c.jpg"><figcaption>1.3 s</figcaption></figure>',
    );
    expect(html).toContain("grid-template-columns: repeat(3, 1fr)");
    expect(
      html.startsWith('<!doctype html><html><head><meta charset="utf-8">'),
    ).toBe(true);
  });
});

describe("recordVideo", () => {
  let out = "";
  let clock = 0;
  let sheetHtml = "";
  let shotMs = 0;
  let sleeps: number[] = [];
  let mouseAt: number[] = [];

  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), "bcct-video-out-"));
    clock = 0;
    sheetHtml = "";
    shotMs = 0;
    sleeps = [];
    mouseAt = [];
  });

  afterEach(() => {
    rmSync(out, { recursive: true, force: true });
  });

  function videoPage(center: unknown = { x: 5, y: 6 }): FakeCdpPage {
    let frame = 0;

    return fakeCdpPage((method, params): CdpResult => {
      if (method === "Runtime.evaluate") {
        return evaluatedValue(
          String(params.expression).includes("centerOf") ? center : [],
        );
      }

      if (method === "Page.navigate" && String(params.url).endsWith(".html")) {
        sheetHtml = readFileSync(fileURLToPath(String(params.url)), "utf8");
      }

      if (method === "Page.getLayoutMetrics") {
        return {
          cssContentSize: { width: 1200, height: 500 },
          cssVisualViewport: {
            pageX: 0,
            pageY: 0,
            clientWidth: 640,
            clientHeight: 360,
          },
        };
      }

      if (method === "Input.dispatchMouseEvent") mouseAt.push(clock);

      if (method === "Page.captureScreenshot") {
        frame += 1;
        clock += shotMs;

        return { data: Buffer.from(`image ${frame}`).toString("base64") };
      }

      return {};
    });
  }

  function record(
    page: FakeCdpPage,
    video: VideoShot = VIDEO,
    runFfmpeg: (args: string[]) => number | null = () => 0,
  ): ReturnType<typeof recordVideo> {
    return recordVideo(page, VIEWPORT, video, out, {
      runFfmpeg,
      now: () => clock,
      sleep: (ms) => {
        sleeps.push(ms);
        clock += ms;

        return Promise.resolve();
      },
    });
  }

  it("records a frame per interval, starts the steps after the lead-in and encodes them at the measured rate", async (): Promise<void> => {
    const page = videoPage();
    const encoded: string[][] = [];
    const recorded: string[] = [];

    const paths = await record(page, VIDEO, (args) => {
      const framesDir = dirname(args[args.indexOf("-i") + 1]);

      encoded.push(args);
      recorded.push(
        ...readdirSync(framesDir).map((name) =>
          readFileSync(join(framesDir, name), "utf8"),
        ),
      );

      return 0;
    });

    expect(paths).toEqual([
      join(out, "open-menu.mp4"),
      join(out, "open-menu-sheet.png"),
    ]);
    expect(recorded).toEqual(["image 1", "image 2", "image 3", "image 4"]);
    expect(encoded).toEqual([
      ffmpegArgs(dirname(encoded[0][6]), 4, join(out, "open-menu.mp4")),
    ]);

    const methods = page.calls.map(([method]) => method);
    const shots = methods.flatMap((method, index) =>
      method === "Page.captureScreenshot" ? [index] : [],
    );

    expect(methods.indexOf("Input.dispatchMouseEvent")).toBeGreaterThan(
      shots[1],
    );
    expect(methods.indexOf("Input.dispatchMouseEvent")).toBeLessThan(shots[3]);
    expect(page.evaluated()).toContain(
      pageCall(drawOutline, ["#menu"], OUTLINE),
    );
    expect(page.evaluated()).toContain(pageCall(centerOf, "#menu"));
  });

  it("captures the frames as JPEG of the visible area", async (): Promise<void> => {
    const page = videoPage();

    await record(page);

    expect(
      page.calls.find(([method]) => method === "Page.captureScreenshot")?.[1],
    ).toEqual({
      format: "jpeg",
      quality: 90,
      clip: { x: 0, y: 0, width: 640, height: 360, scale: 1 },
      captureBeyondViewport: true,
    });
  });

  it("writes the sheet of the frames with their times and removes the frames afterwards", async (): Promise<void> => {
    let framesDir = "";

    const paths = await record(videoPage(), VIDEO, (args) => {
      framesDir = dirname(args[args.indexOf("-i") + 1]);

      return 0;
    });

    expect(sheetHtml).toContain("<figcaption>0.0 s</figcaption>");
    expect(sheetHtml).toContain("<figcaption>0.8 s</figcaption>");
    expect(readFileSync(paths[1], "utf8")).toBe("image 5");
    expect(existsSync(framesDir)).toBe(false);
  });

  it("keeps recording until the steps start in a video shorter than its frame interval", async (): Promise<void> => {
    const page = videoPage();

    await record(page, { ...VIDEO, seconds: 1, fps: 1 });

    expect(
      page.calls.filter(([method]) => method === "Input.dispatchMouseEvent"),
    ).toHaveLength(3);
    expect(
      page.calls.filter(([method]) => method === "Page.captureScreenshot"),
    ).toHaveLength(3);
  });

  it("starts the steps halfway through a video shorter than the lead-in", async (): Promise<void> => {
    const page = videoPage();

    await record(page, { ...VIDEO, seconds: 0.4, fps: 10 });

    const methods = page.calls.map(([method]) => method);
    const shots = methods.flatMap((method, index) =>
      method === "Page.captureScreenshot" ? [index] : [],
    );

    expect(shots.length).toBeGreaterThanOrEqual(4);
    expect(methods.indexOf("Input.dispatchMouseEvent")).toBeGreaterThan(
      shots[1],
    );
    expect(methods.indexOf("Input.dispatchMouseEvent")).toBeLessThan(shots[3]);
  });

  it("throws the failure of a step after the recording, without encoding", async (): Promise<void> => {
    const encoded: string[][] = [];

    await expect(
      record(videoPage(null), VIDEO, (args) => {
        encoded.push(args);

        return 0;
      }),
    ).rejects.toThrow("no element matches #menu");
    expect(encoded).toEqual([]);
  });

  it("throws the path ffmpeg could not write and removes the frames", async (): Promise<void> => {
    let framesDir = "";
    const failed = record(videoPage(), VIDEO, (args) => {
      framesDir = dirname(args[args.indexOf("-i") + 1]);

      return 1;
    });

    await expect(failed).rejects.toThrow(FfmpegError);
    await expect(failed).rejects.toMatchObject({
      outputPath: join(out, "open-menu.mp4"),
    });
    expect(existsSync(framesDir)).toBe(false);
    await expect(record(videoPage(), VIDEO, () => null)).rejects.toThrow(
      `ffmpeg failed to write ${join(out, "open-menu.mp4")}`,
    );
  });

  it("keeps the interval between frames and the encode rate when the clock does not start at zero", async (): Promise<void> => {
    clock = 10_000;
    shotMs = 50;

    const encoded: string[][] = [];

    await record(videoPage(), VIDEO, (args) => {
      encoded.push(args);

      return 0;
    });

    expect(sleeps).toEqual([200, 200, 200, 200]);
    expect(mouseAt[0]).toBeGreaterThanOrEqual(10_500);
    expect(encoded[0][encoded[0].indexOf("-framerate") + 1]).toBe("4.000");
  });

  it("does not sleep when a frame takes longer than its interval", async (): Promise<void> => {
    shotMs = 400;

    await record(videoPage(), { ...VIDEO, seconds: 1, fps: 4 });

    expect(sleeps.every((ms) => ms === 0)).toBe(true);
  });

  it("starts the steps only after the lead-in", async (): Promise<void> => {
    await record(videoPage());

    expect(mouseAt).toHaveLength(3);
    expect(mouseAt[0]).toBeGreaterThanOrEqual(LEAD_IN_MS);
  });

  it("numbers the frame files in four digits from 1 in a folder named after the frames", async (): Promise<void> => {
    let names: string[] = [];
    let framesDir = "";

    await record(videoPage(), VIDEO, (args) => {
      framesDir = dirname(args[args.indexOf("-i") + 1]);
      names = readdirSync(framesDir);

      return 0;
    });

    expect(names.filter((name) => name.endsWith(".jpg")).toSorted()).toEqual([
      "frame-0001.jpg",
      "frame-0002.jpg",
      "frame-0003.jpg",
      "frame-0004.jpg",
    ]);
    expect(basename(framesDir).startsWith("bcct-frames-")).toBe(true);
  });

  it("captures the sheet of the full page without drawing the outline again", async (): Promise<void> => {
    const page = videoPage();

    await record(page);

    const shots = page.calls.filter(
      ([method]) => method === "Page.captureScreenshot",
    );

    expect(shots.at(-1)?.[1]?.clip).toEqual({
      x: 0,
      y: 0,
      width: 1200,
      height: 500,
      scale: 1,
    });
    expect(
      page
        .evaluated()
        .filter((expression) =>
          String(expression).includes(JSON.stringify(OUTLINE)),
        ),
    ).toHaveLength(1);
  });

  it("throws the Error of a failed step itself", async (): Promise<void> => {
    await expect(record(videoPage(null))).rejects.toBeInstanceOf(Error);
  });

  describe("recordVideo › default clock", () => {
    beforeEach((): void => {
      vi.useFakeTimers();
    });

    afterEach((): void => {
      vi.useRealTimers();
    });

    it("uses the global clock and timers by default", async (): Promise<void> => {
      let settled = false;
      const recording = recordVideo(
        videoPage(),
        VIEWPORT,
        { ...VIDEO, seconds: 0.1, fps: 20 },
        out,
        { runFfmpeg: () => 0 },
      ).finally((): void => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(99);

      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);

      expect(settled).toBe(true);
      expect(await recording).toHaveLength(2);
    });
  });
});
