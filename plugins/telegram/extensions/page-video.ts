import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { tempPrefix } from "./capture-leftovers.ts";
import type { CdpPage } from "./cdp.ts";
import {
  areaOfShot,
  captureShot,
  openShot,
  outlineShot,
  runSteps,
  screenshot,
  type Viewport,
} from "./page-actions.ts";
import { escapeHtml } from "./page-board.ts";
import type { PageRect } from "./page-dom.ts";
import type { VideoShot } from "./page-spec.ts";

export interface Frame {
  path: string;
  atMs: number;
}

export interface VideoDeps {
  runFfmpeg: (args: string[]) => number | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}

export class FfmpegError extends Error {
  readonly outputPath: string;

  constructor(outputPath: string) {
    super(`ffmpeg failed to write ${outputPath}`);
    this.outputPath = outputPath;
  }
}

export const LEAD_IN_MS = 500;
export const SHEET_FRAMES = 6;
export const SHEET_VIEWPORT: Viewport = { width: 1200, height: 100, scale: 1 };
export const FRAME_PATTERN = "frame-%04d.jpg";

const SHEET_STYLE = [
  "body { margin: 0; padding: 16px; background: #fff; color: #475569; font: 14px system-ui, sans-serif; display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px }",
  "figure { margin: 0 }",
  "img { display: block; width: 100%; border: 1px solid #cbd5e1 }",
  "figcaption { margin-top: 4px }",
].join("\n");

export function ffmpegArgs(
  framesDir: string,
  rate: number,
  outputPath: string,
): string[] {
  return [
    "-y",
    "-loglevel",
    "error",
    "-framerate",
    rate.toFixed(3),
    "-i",
    join(framesDir, FRAME_PATTERN),
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2:out_range=tv,format=yuv420p",
    "-c:v",
    "libx264",
    "-movflags",
    "+faststart",
    outputPath,
  ];
}

export function pickSheetFrames(frames: Frame[]): Frame[] {
  const count = Math.min(SHEET_FRAMES, frames.length);
  const step = (frames.length - 1) / Math.max(count - 1, 1);

  return Array.from(
    { length: count },
    (_, index) => frames[Math.round(index * step)],
  );
}

export function frameSheetHtml(frames: Frame[]): string {
  const figures = frames
    .map(
      ({ path, atMs }) =>
        `<figure><img src="${pathToFileURL(path).href}"><figcaption>${escapeHtml((atMs / 1000).toFixed(1))} s</figcaption></figure>`,
    )
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><style>${SHEET_STYLE}</style></head><body>${figures}</body></html>`;
}

function framePath(framesDir: string, index: number): string {
  return join(framesDir, `frame-${String(index).padStart(4, "0")}.jpg`);
}

async function recordFrames(
  page: CdpPage,
  video: VideoShot,
  area: PageRect,
  framesDir: string,
  now: () => number,
  sleep: (ms: number) => Promise<unknown>,
): Promise<{ frames: Frame[]; rate: number }> {
  const frames: Frame[] = [];
  const intervalMs = 1000 / video.fps;
  const durationMs = video.seconds * 1000;
  const leadInMs = Math.min(LEAD_IN_MS, durationMs / 2);
  const start = now();
  let acting: Promise<{ error: unknown } | null> | null = null;

  while (now() - start < durationMs || acting === null) {
    const atMs = now() - start;
    const path = framePath(framesDir, frames.length + 1);

    if (acting === null && atMs >= leadInMs) {
      acting = runSteps(page, video.steps).then(
        () => null,
        (error: unknown) => ({ error }),
      );
    }

    writeFileSync(path, await screenshot(page, area, "jpeg"));
    frames.push({ path, atMs });
    await sleep(Math.max(0, intervalMs - (now() - start - atMs)));
  }

  const elapsedMs = now() - start;
  const failure = await acting;

  if (failure !== null) throw failure.error;

  return { frames, rate: (frames.length * 1000) / elapsedMs };
}

export async function recordVideo(
  page: CdpPage,
  viewport: Viewport,
  video: VideoShot,
  out: string,
  { runFfmpeg, now = Date.now, sleep = delay }: VideoDeps,
): Promise<string[]> {
  await openShot(page, viewport, video);
  await outlineShot(page, video.outline);

  const area = await areaOfShot(page, video);
  const framesDir = mkdtempSync(join(tmpdir(), tempPrefix("frames")));

  try {
    const { frames, rate } = await recordFrames(
      page,
      video,
      area,
      framesDir,
      now,
      sleep,
    );
    const mp4 = join(out, `${video.name}.mp4`);

    if (runFfmpeg(ffmpegArgs(framesDir, rate, mp4)) !== 0) {
      throw new FfmpegError(mp4);
    }

    const sheetHtml = join(framesDir, "sheet.html");

    writeFileSync(sheetHtml, frameSheetHtml(pickSheetFrames(frames)));

    const sheet = await captureShot(
      page,
      SHEET_VIEWPORT,
      {
        name: `${video.name}-sheet`,
        url: pathToFileURL(sheetHtml).href,
        css: null,
        steps: [],
        outline: [],
        clip: null,
        fullPage: true,
      },
      out,
    );

    return [mp4, ...sheet];
  } finally {
    rmSync(framesDir, { recursive: true });
  }
}
