import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { CDP_TIMEOUT_MS, inSeconds, withTimeout, type CdpPage } from "./cdp.ts";
import {
  addStyle,
  areaOf,
  centerOf,
  drawOutline,
  fontsReady,
  pageCall,
  type OutlineStyle,
  type PagePoint,
  type PageRect,
} from "./page-dom.ts";
import type { Shot, Step } from "./page-spec.ts";

export interface Viewport {
  width: number;
  height: number;
  scale: number;
}

export type ImageFormat = "png" | "jpeg";

export const OUTLINE: OutlineStyle = { color: "#e11d48", width: 4, offset: 4 };
export const CLIP_MARGIN_PX = 16;
export const PART_MAX_HEIGHT_PX = 2560;
export const JPEG_QUALITY = 90;
export const BLANK_URL = "about:blank";

type Fields = Record<string, unknown>;

function fieldsOf(value: unknown): Fields {
  return typeof value === "object" && value !== null ? (value as Fields) : {};
}

function numbersIn(value: unknown, keys: string[]): boolean {
  const fields = fieldsOf(value);

  return keys.every((key) => typeof fields[key] === "number");
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

function isRect(value: unknown): value is PageRect {
  return numbersIn(value, ["x", "y", "width", "height"]);
}

function isPoint(value: unknown): value is PagePoint {
  return numbersIn(value, ["x", "y"]);
}

export async function evaluate(
  page: CdpPage,
  expression: string,
): Promise<unknown> {
  const { result, exceptionDetails } = await page.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });

  if (exceptionDetails !== undefined) {
    const details = fieldsOf(exceptionDetails);

    throw new Error(
      String(fieldsOf(details.exception).description ?? details.text),
    );
  }

  return fieldsOf(result).value;
}

async function navigate(
  page: CdpPage,
  url: string,
  loadTimeoutMs: number,
): Promise<void> {
  const loaded = page.once("Page.loadEventFired");
  const { errorText } = await page.send("Page.navigate", { url });

  if (isText(errorText)) throw new Error(`${url}: ${errorText}`);

  await withTimeout(
    loaded,
    loadTimeoutMs,
    `${url} did not load in ${inSeconds(loadTimeoutMs)}`,
  );
}

export async function openShot(
  page: CdpPage,
  { width, height, scale }: Viewport,
  shot: Shot,
  loadTimeoutMs: number = CDP_TIMEOUT_MS,
): Promise<void> {
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: scale,
    mobile: false,
  });

  await navigate(page, BLANK_URL, loadTimeoutMs);
  await navigate(page, shot.url, loadTimeoutMs);
  await evaluate(page, pageCall(fontsReady));

  if (shot.css !== null) await evaluate(page, pageCall(addStyle, shot.css));
}

async function runStep(page: CdpPage, step: Step): Promise<void> {
  if ("wait" in step) {
    await sleep(step.wait);

    return;
  }

  if ("script" in step) {
    await evaluate(page, step.script);

    return;
  }

  const selector = "click" in step ? step.click : step.hover;
  const point = await evaluate(page, pageCall(centerOf, selector));

  if (!isPoint(point)) throw new Error(`no element matches ${selector}`);

  const mouse = { x: point.x, y: point.y };

  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...mouse });

  if ("click" in step) {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await page.send("Input.dispatchMouseEvent", {
        type,
        ...mouse,
        button: "left",
        clickCount: 1,
      });
    }
  }
}

export async function runSteps(page: CdpPage, steps: Step[]): Promise<void> {
  for (const step of steps) await runStep(page, step);
}

export async function outlineShot(
  page: CdpPage,
  selectors: string[],
): Promise<void> {
  if (selectors.length === 0) return;

  const unmatched = await evaluate(
    page,
    pageCall(drawOutline, selectors, OUTLINE),
  );

  if (Array.isArray(unmatched) && unmatched.length > 0) {
    throw new Error(`no element matches ${unmatched.join(", ")}`);
  }
}

export async function areaOfShot(page: CdpPage, shot: Shot): Promise<PageRect> {
  if (shot.clip !== null) {
    const area = await evaluate(
      page,
      pageCall(areaOf, shot.clip, CLIP_MARGIN_PX),
    );

    if (!isRect(area)) throw new Error(`no element matches ${shot.clip}`);

    return area;
  }

  const metrics = await page.send("Page.getLayoutMetrics");

  if (shot.fullPage) {
    const content = fieldsOf(metrics.cssContentSize);

    return {
      x: 0,
      y: 0,
      width: Number(content.width),
      height: Number(content.height),
    };
  }

  const visible = fieldsOf(metrics.cssVisualViewport);

  return {
    x: Number(visible.pageX),
    y: Number(visible.pageY),
    width: Number(visible.clientWidth),
    height: Number(visible.clientHeight),
  };
}

export function splitArea(area: PageRect, scale: number): PageRect[] {
  const parts = Math.max(
    1,
    Math.ceil((area.height * scale) / PART_MAX_HEIGHT_PX),
  );
  const partHeight = Math.ceil(area.height / parts);

  return Array.from({ length: parts }, (_, index) => ({
    ...area,
    y: area.y + index * partHeight,
    height: Math.min(partHeight, area.height - index * partHeight),
  }));
}

export async function screenshot(
  page: CdpPage,
  area: PageRect,
  format: ImageFormat,
): Promise<Buffer> {
  const { data } = await page.send("Page.captureScreenshot", {
    format,
    ...(format === "jpeg" ? { quality: JPEG_QUALITY } : {}),
    clip: { ...area, scale: 1 },
    captureBeyondViewport: true,
  });

  return Buffer.from(String(data), "base64");
}

export function partPaths(out: string, name: string, parts: number): string[] {
  return parts === 1
    ? [join(out, `${name}.png`)]
    : Array.from({ length: parts }, (_, index) =>
        join(out, `${name}-${index + 1}.png`),
      );
}

export async function captureShot(
  page: CdpPage,
  viewport: Viewport,
  shot: Shot,
  out: string,
): Promise<string[]> {
  await openShot(page, viewport, shot);
  await runSteps(page, shot.steps);
  await outlineShot(page, shot.outline);

  const parts = splitArea(await areaOfShot(page, shot), viewport.scale);
  const paths = partPaths(out, shot.name, parts.length);

  for (const [index, part] of parts.entries()) {
    writeFileSync(paths[index], await screenshot(page, part, "png"));
  }

  return paths;
}
