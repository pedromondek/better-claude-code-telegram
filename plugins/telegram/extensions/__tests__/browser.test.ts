import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findPlaywrightChromium,
  playwrightCacheDir,
  playwrightChromium,
} from "../browser.ts";

interface ChromiumCase {
  name: string;
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string>;
  tree: Record<string, string[]>;
  expected: { cacheDir: string; chromium: string | null };
}

const CHROMIUM_CASES = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "fixtures", "playwright-chromium.json"),
    "utf8",
  ),
) as ChromiumCase[];

function fakeTree(tree: Record<string, string[]>): (dir: string) => string[] {
  return (dir: string): string[] => {
    const entries = tree[dir];

    if (entries === undefined) throw new Error(`ENOENT ${dir}`);

    return entries;
  };
}

describe("playwrightChromium › the contract shared with the bcct binary", () => {
  it.each(CHROMIUM_CASES)(
    "$name",
    ({ platform, home, env, tree, expected }): void => {
      const host = { platform, home, env };
      const cacheDir = playwrightCacheDir(host);

      expect(cacheDir).toBe(expected.cacheDir);
      expect(findPlaywrightChromium(cacheDir, platform, fakeTree(tree))).toBe(
        expected.chromium,
      );
      expect(playwrightChromium(host, fakeTree(tree))).toBe(expected.chromium);
    },
  );
});

describe("playwrightChromium › real folders", () => {
  let cache = "";

  beforeEach(() => {
    cache = mkdtempSync(join(tmpdir(), "bcct-browser-"));
  });

  afterEach(() => {
    rmSync(cache, { recursive: true, force: true });
  });

  it("reads the real folders of the cache by default", (): void => {
    mkdirSync(join(cache, "chromium-1243", "chrome-linux64"), {
      recursive: true,
    });

    expect(
      playwrightChromium({
        platform: "linux",
        home: homedir(),
        env: { PLAYWRIGHT_BROWSERS_PATH: cache },
      }),
    ).toBe(join(cache, "chromium-1243", "chrome-linux64", "chrome"));
  });

  it("uses the platform, the home and the environment of the process by default", (): void => {
    expect(playwrightCacheDir()).toBe(
      playwrightCacheDir({
        platform: process.platform,
        home: homedir(),
        env: process.env,
      }),
    );
  });
});
