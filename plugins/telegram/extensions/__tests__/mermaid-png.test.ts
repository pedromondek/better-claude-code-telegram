import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MESSAGES } from "../i18n.ts";
import {
  commandExists,
  findPlaywrightChromium,
  MERMAID_SCRIPT,
  mermaidCommand,
  mmdcArgs,
  pngPathFor,
  renderMermaid,
  runAsScript,
  runCommand,
} from "../mermaid-png.ts";

const EN = MESSAGES["en-us"];

function fakeTree(tree: Record<string, string[]>): (dir: string) => string[] {
  return (dir: string): string[] => {
    const entries = tree[dir];

    if (entries === undefined) throw new Error(`ENOENT ${dir}`);

    return entries;
  };
}

describe("findPlaywrightChromium", () => {
  it("picks the newest Chromium from the Playwright cache", (): void => {
    const listDir = fakeTree({
      "/cache": [
        "chromium-1208",
        "chromium-1243",
        "firefox-1500",
        "chromium_headless_shell-1243",
      ],
      "/cache/chromium-1243": ["chrome-linux64"],
      "/cache/chromium-1208": ["chrome-linux"],
    });

    expect(findPlaywrightChromium("/cache", listDir)).toBe(
      "/cache/chromium-1243/chrome-linux64/chrome",
    );
  });

  it("skips the version that has no Linux folder", (): void => {
    const listDir = fakeTree({
      "/cache": ["chromium-1243", "chromium-1208"],
      "/cache/chromium-1243": ["chrome-mac"],
      "/cache/chromium-1208": ["chrome-linux"],
    });

    expect(findPlaywrightChromium("/cache", listDir)).toBe(
      "/cache/chromium-1208/chrome-linux/chrome",
    );
  });

  it("ignores the headless shell and the folders whose name only contains chromium-<version>", (): void => {
    const listDir = fakeTree({
      "/cache": [
        "chromium_headless_shell-1300",
        "old-chromium-1301",
        "chromium-1302-partial",
        "chromium-1208",
      ],
      "/cache/chromium_headless_shell-1300": ["chrome-linux"],
      "/cache/old-chromium-1301": ["chrome-linux"],
      "/cache/chromium-1302-partial": ["chrome-linux"],
      "/cache/chromium-1208": ["chrome-linux"],
    });

    expect(findPlaywrightChromium("/cache", listDir)).toBe(
      "/cache/chromium-1208/chrome-linux/chrome",
    );
  });

  it("skips the version whose folder cannot be read", (): void => {
    const listDir = fakeTree({
      "/cache": ["chromium-1243", "chromium-1208"],
      "/cache/chromium-1208": ["chrome-linux"],
    });

    expect(findPlaywrightChromium("/cache", listDir)).toBe(
      "/cache/chromium-1208/chrome-linux/chrome",
    );
  });

  it("returns null when the Playwright cache does not exist", (): void => {
    expect(findPlaywrightChromium("/no-cache", fakeTree({}))).toBeNull();
  });
});

describe("pngPathFor", () => {
  it("swaps the .mmd extension for .png", (): void => {
    expect(pngPathFor("/tmp/flow.mmd")).toBe("/tmp/flow.png");
    expect(pngPathFor("/tmp/flow")).toBe("/tmp/flow.png");
  });

  it("keeps a .mmd that is not the extension", (): void => {
    expect(pngPathFor("/tmp/flow.mmd.txt")).toBe("/tmp/flow.mmd.txt.png");
  });
});

describe("mmdcArgs", () => {
  it("uses a white background, scale 2 and size 1400, with the Chromium config when there is one", (): void => {
    expect(mmdcArgs("a.mmd", "a.png", "/tmp/p.json")).toEqual([
      "-p",
      "/tmp/p.json",
      "-i",
      "a.mmd",
      "-o",
      "a.png",
      "-b",
      "white",
      "-s",
      "2",
      "--size",
      "1400",
    ]);
    expect(mmdcArgs("a.mmd", "a.png", null)[0]).toBe("-i");
  });
});

describe("mermaidCommand", () => {
  it("runs the script with bun using its absolute path in quotes", (): void => {
    expect(isAbsolute(MERMAID_SCRIPT)).toBe(true);
    expect(MERMAID_SCRIPT.endsWith("mermaid-png.ts")).toBe(true);
    expect(mermaidCommand()).toBe(`bun "${MERMAID_SCRIPT}"`);
  });
});

describe("commandExists and runCommand", () => {
  it("finds a command on the PATH and refuses a missing one", (): void => {
    expect(commandExists("sh")).toBe(true);
    expect(commandExists("bcct-no-such-command")).toBe(false);
  });

  it("returns the exit code of the command", (): void => {
    expect(runCommand("sh", ["-c", "exit 0"])).toBe(0);
    expect(runCommand("sh", ["-c", "exit 3"])).toBe(3);
  });

  it("gives the command no input, hides its output so the script prints only the PNG path, and shows its errors on the terminal of the script", (): void => {
    const stdioOfTheCommand = [
      '[ "$(readlink /proc/$$/fd/0)" = /dev/null ]',
      '[ "$(readlink /proc/$$/fd/1)" = /dev/null ]',
      '[ "$(readlink /proc/$$/fd/2)" = "$(readlink /proc/$PPID/fd/2)" ]',
    ].join(" && ");

    expect(runCommand("sh", ["-c", stdioOfTheCommand])).toBe(0);
  });
});

describe("renderMermaid", () => {
  let dir = "";

  function run(
    input: string | undefined,
    options: Parameters<typeof renderMermaid>[1] = {},
  ): { code: number; out: string[]; err: string[]; calls: string[][] } {
    const out: string[] = [];
    const err: string[] = [];
    const calls: string[][] = [];
    const code = renderMermaid(input, {
      messages: EN,
      playwrightCache: join(dir, "no-cache"),
      hasMmdc: () => true,
      runMmdc: (args) => {
        calls.push(args);

        return 0;
      },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      ...options,
    });

    return { code, out, err, calls };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bcct-mermaid-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows the usage and fails without a file", (): void => {
    const result = run(undefined);

    expect(result.code).toBe(1);
    expect(result.err).toEqual([EN.mermaidUsage(mermaidCommand())]);
    expect(result.calls).toEqual([]);
  });

  it("explains how to install mmdc when it is missing", (): void => {
    const result = run("flow.mmd", { hasMmdc: () => false });

    expect(result.code).toBe(1);
    expect(result.err).toEqual([EN.mermaidMissingCli]);
  });

  it("renders the file next to it as a PNG and prints its path", (): void => {
    const input = join(dir, "flow.mmd");
    const result = run(input);

    expect(result.code).toBe(0);
    expect(result.out).toEqual([join(dir, "flow.png")]);
    expect(result.calls).toEqual([
      mmdcArgs(input, join(dir, "flow.png"), null),
    ]);
  });

  it("hands mmdc a Puppeteer config with the Playwright Chromium, and removes it afterwards", (): void => {
    const cache = join(dir, "ms-playwright");
    const chrome = join(cache, "chromium-1243", "chrome-linux", "chrome");
    mkdirSync(dirname(chrome), { recursive: true });
    let config: unknown = null;

    const result = run(join(dir, "flow.mmd"), {
      playwrightCache: cache,
      runMmdc: (args) => {
        const configPath = args[1];
        config = JSON.parse(readFileSync(configPath, "utf8"));

        return 0;
      },
    });

    expect(result.code).toBe(0);
    expect(config).toEqual({
      executablePath: chrome,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    expect(
      readdirSync(tmpdir()).filter((name) => name.startsWith("mermaid-png-")),
    ).toEqual([]);
  });

  it("fails with the exit code of mmdc and names the PNG it could not write", (): void => {
    const result = run(join(dir, "flow.mmd"), { runMmdc: () => 4 });

    expect(result.code).toBe(4);
    expect(result.err).toEqual([EN.mermaidFailed(join(dir, "flow.png"))]);
    expect(run(join(dir, "flow.mmd"), { runMmdc: () => null }).code).toBe(1);
  });

  it("by default runs the mmdc on the PATH and prints to the console", (): void => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "mmdc"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(renderMermaid(join(dir, "flow.mmd"))).toBe(0);
    expect(log).toHaveBeenCalledWith(join(dir, "flow.png"));
    expect(renderMermaid(undefined)).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("runAsScript", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("renders only when it is the script that node or bun runs", (): void => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    runAsScript(["bun", "/elsewhere/index.ts"]);
    expect(process.exitCode).toBeUndefined();

    runAsScript(["bun", MERMAID_SCRIPT]);
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
