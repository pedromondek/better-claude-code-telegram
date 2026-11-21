import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MESSAGES } from "../i18n.ts";
import {
  MERMAID_SCRIPT,
  MMDC,
  mermaidCommand,
  mmdcArgs,
  pngPathFor,
  renderMermaid,
  runAsScript,
} from "../mermaid-png.ts";

const EN = MESSAGES["en-us"];

describe("mermaid-png › constants", () => {
  it("runs the mmdc of the PATH", (): void => {
    expect(MMDC).toBe("mmdc");
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
    let configDir = "";

    const result = run(join(dir, "flow.mmd"), {
      playwrightCache: cache,
      runMmdc: (args) => {
        const configPath = args[1];
        configDir = dirname(configPath);
        config = JSON.parse(readFileSync(configPath, "utf8"));

        return 0;
      },
    });

    expect(result.code).toBe(0);
    expect(config).toEqual({
      executablePath: chrome,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    expect(dirname(configDir)).toBe(tmpdir());
    expect(basename(configDir)).toMatch(/^mermaid-png-\w{6}$/);
    expect(existsSync(configDir)).toBe(false);
  });

  it("prints the PNG path when the Puppeteer config folder is gone after mmdc", (): void => {
    const cache = join(dir, "ms-playwright");
    mkdirSync(join(cache, "chromium-1243", "chrome-linux"), {
      recursive: true,
    });
    let flag = "";

    const result = run(join(dir, "flow.mmd"), {
      playwrightCache: cache,
      runMmdc: (args) => {
        flag = args[0];
        rmSync(dirname(args[1]), { recursive: true });

        return 0;
      },
    });

    expect(flag).toBe("-p");
    expect(result.code).toBe(0);
    expect(result.out).toEqual([join(dir, "flow.png")]);
  });

  it("fails with the exit code of mmdc and names the PNG it could not write", (): void => {
    const result = run(join(dir, "flow.mmd"), { runMmdc: () => 4 });

    expect(result.code).toBe(4);
    expect(result.err).toEqual([EN.mermaidFailed(join(dir, "flow.png"))]);
    expect(run(join(dir, "flow.mmd"), { runMmdc: () => null }).code).toBe(1);
  });

  it("finds the Chromium of the Playwright cache of the system by default", (): void => {
    const cache = join(dir, "browsers");
    const chrome = join(cache, "chromium-1243", "chrome-linux64", "chrome");
    let config: unknown = null;

    mkdirSync(dirname(chrome), { recursive: true });
    vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", cache);

    const result = renderMermaid(join(dir, "flow.mmd"), {
      messages: EN,
      hasMmdc: () => true,
      runMmdc: (args) => {
        config = JSON.parse(readFileSync(args[1], "utf8"));

        return 0;
      },
      out: () => undefined,
    });

    expect(result).toBe(0);
    expect(config).toMatchObject({ executablePath: chrome });
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
