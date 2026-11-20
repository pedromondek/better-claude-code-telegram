import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { playwrightCacheDir, playwrightChromium } from "../browser.ts";
import { commandExists } from "../command.ts";
import { MESSAGES } from "../i18n.ts";
import { CAPTURE_SCRIPT } from "../page-capture.ts";

const EN = MESSAGES["en-us"];
const HOST = {
  platform: process.platform,
  home: userInfo().homedir,
  env: process.env,
};
const BROWSERS = playwrightCacheDir(HOST);
const hasBun = commandExists("bun");
const canRun = hasBun && playwrightChromium(HOST) !== null;
const canRecord = canRun && commandExists("ffmpeg");
const skipNote = canRun
  ? ""
  : " [skipped: needs bun and the Chromium of Playwright, run npx playwright install chromium]";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body { margin: 0; font: 15px sans-serif }
header { display: flex; padding: 12px 20px; background: #0f172a; color: #fff }
#menu { margin-left: auto }
.list { display: none }
.list.open { display: block }
main { height: 3000px }
</style></head><body>
<header><span>Acme</span><button id="menu" onclick="document.querySelector('.list').classList.add('open')">Menu</button></header>
<div class="list"><div>Buscar</div></div>
<main>Conteúdo</main></body></html>`;

let dir = "";

function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);

  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function capture(
  spec: unknown,
  env: Record<string, string> = {},
): {
  status: number | null;
  stdout: string[];
  stderr: string;
} {
  const specPath = join(dir, "spec.json");

  writeFileSync(join(dir, "app.html"), PAGE);
  writeFileSync(specPath, JSON.stringify(spec));

  const result = spawnSync("bun", [CAPTURE_SCRIPT, specPath], {
    encoding: "utf8",
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: BROWSERS, ...env },
    timeout: 60_000,
  });

  return {
    status: result.status,
    stdout: result.stdout.split("\n").filter(Boolean),
    stderr: result.stderr,
  };
}

describe.skipIf(!canRun)(
  `Claude captures a proposal board of a local page with the real Chromium${skipNote}`,
  () => {
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "bcct-capture-e2e-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("writes the states at 2x, the tall page in parts and the board, printing each path", (): void => {
      const result = capture({
        url: "app.html",
        out: "out",
        width: 600,
        height: 400,
        shots: [
          { name: "today", outline: "#menu", clip: "header" },
          {
            name: "open",
            steps: [{ click: "#menu" }, { wait: 100 }],
            outline: ".list",
          },
          { name: "page", fullPage: true },
        ],
        board: {
          name: "board",
          title: "Menu",
          sections: [
            {
              heading: "Hoje",
              cards: [
                { shot: "today", label: "Fechado" },
                { shot: "open", label: "Aberto" },
              ],
            },
          ],
        },
      });
      const out = join(dir, "out");

      expect({ status: result.status, stderr: result.stderr }).toEqual({
        status: 0,
        stderr: "",
      });
      expect(result.stdout).toEqual([
        join(out, "today.png"),
        join(out, "open.png"),
        join(out, "page-1.png"),
        join(out, "page-2.png"),
        join(out, "page-3.png"),
        join(out, "board.png"),
      ]);
      expect(pngSize(join(out, "today.png")).width).toBe(1200);
      expect(pngSize(join(out, "open.png"))).toEqual({
        width: 1200,
        height: 800,
      });
      expect(
        ["page-1.png", "page-2.png", "page-3.png"].every(
          (name) => pngSize(join(out, name)).height <= 2560,
        ),
      ).toBe(true);
      expect(pngSize(join(out, "board.png")).width).toBe(2400);
      expect(readdirSync(out)).not.toContain("board.html");
    });

    it("captures every shot of a page whose url carries a fragment", (): void => {
      const result = capture({
        url: `${pathToFileURL(join(dir, "app.html")).href}#/settings`,
        shots: [
          { name: "today" },
          { name: "styled", css: "body { color: red }" },
        ],
      });

      expect({ status: result.status, stderr: result.stderr }).toEqual({
        status: 0,
        stderr: "",
      });
      expect(result.stdout).toEqual([
        join(dir, "today.png"),
        join(dir, "styled.png"),
      ]);
    });

    it("leaves nothing in the temporary folder once the capture ends", (): void => {
      const temp = join(dir, "tmp");

      mkdirSync(temp);

      const result = capture(
        { url: "app.html", out: "out", shots: [{ name: "today" }] },
        { TMPDIR: temp },
      );

      expect(result.status).toBe(0);
      expect(readdirSync(temp)).toEqual([]);
    });

    it("fails naming the selector that matched nothing", (): void => {
      const result = capture({
        url: "app.html",
        shots: [{ name: "gone", outline: "#gone" }],
      });

      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe(
        EN.captureFailed("Error: no element matches #gone"),
      );
    });

    it.skipIf(!canRecord)(
      "records the click as an H.264 video with its sheet of frames",
      (): void => {
        const result = capture({
          url: "app.html",
          videos: [
            {
              name: "open",
              steps: [{ click: "#menu" }],
              outline: "#menu",
              clip: "header",
              seconds: 1,
              fps: 10,
            },
          ],
        });
        const video = readFileSync(join(dir, "open.mp4"));

        expect(result.status).toBe(0);
        expect(result.stdout).toEqual([
          join(dir, "open.mp4"),
          join(dir, "open-sheet.png"),
        ]);
        expect(video.subarray(4, 8).toString()).toBe("ftyp");
        expect(video.includes("avc1")).toBe(true);
      },
    );
  },
);
