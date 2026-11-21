import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CHROMIUM_PID_FILE,
  cleanLeftovers,
  killHard,
  listNames,
  processAlive,
  readTextOrNull,
  removeTree,
  tempPrefix,
} from "../capture-leftovers.ts";

describe("the disk and process helpers", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bcct-leftover-helpers-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists the names in a folder and nothing for a folder that does not exist", (): void => {
    writeFileSync(join(dir, "a"), "x");

    expect(listNames(dir)).toEqual(["a"]);
    expect(listNames(join(dir, "missing"))).toEqual([]);
  });

  it("reads the text of a file and null for a file that does not exist", (): void => {
    writeFileSync(join(dir, "pid"), "123");

    expect(readTextOrNull(join(dir, "pid"))).toBe("123");
    expect(readTextOrNull(join(dir, "missing"))).toBeNull();
  });

  it("removes a folder with its content and accepts one already gone", (): void => {
    mkdirSync(join(dir, "tree"));
    writeFileSync(join(dir, "tree", "file"), "x");

    removeTree(join(dir, "tree"));

    expect(existsSync(join(dir, "tree"))).toBe(false);
    expect(() => {
      removeTree(join(dir, "tree"));
    }).not.toThrow();
  });

  it("stops a process at once and ignores one that is gone", async (): Promise<void> => {
    const child = spawn("sleep", ["30"]);
    const exited = new Promise<string | null>((resolve) => {
      child.once("exit", (_code, signal) => resolve(signal));
    });

    killHard(Number(child.pid));

    await expect(exited).resolves.toBe("SIGKILL");
    expect(() => {
      killHard(Number(child.pid));
    }).not.toThrow();
  });
});

describe("tempPrefix", () => {
  it("names each temporary folder after its kind and the process that owns it", (): void => {
    expect(tempPrefix("capture", 42)).toBe("bcct-capture-42-");
    expect(tempPrefix("frames", 7)).toBe("bcct-frames-7-");
    expect(tempPrefix("board")).toBe(`bcct-board-${process.pid}-`);
    expect(CHROMIUM_PID_FILE).toBe("chromium.pid");
  });
});

describe("processAlive", () => {
  it("tells a running process from one that is gone", async (): Promise<void> => {
    const child = spawn("sleep", ["5"]);
    const pid = Number(child.pid);

    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(pid)).toBe(true);

    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));

    expect(processAlive(pid)).toBe(false);
  });

  it("counts a process it may not signal as alive", (): void => {
    expect(processAlive(1)).toBe(true);
  });
});

describe("cleanLeftovers", () => {
  const files: Record<string, string> = {};
  let removed: string[] = [];
  let killed: number[] = [];

  function clean(names: string[], alive: number[]): string[] {
    return cleanLeftovers("/tmp", {
      listDir: () => names,
      isAlive: (pid) => alive.includes(pid),
      readText: (path) => files[path] ?? null,
      kill: (pid) => killed.push(pid),
      remove: (path) => removed.push(path),
    });
  }

  beforeEach(() => {
    for (const key of Object.keys(files)) delete files[key];
    removed = [];
    killed = [];
  });

  it("removes the folders of every kind whose owner is gone and keeps the others", (): void => {
    expect(
      clean(
        [
          "bcct-capture-10-aaa",
          "bcct-frames-10-bbb",
          "bcct-board-10-ccc",
          "bcct-capture-20-ddd",
          "bcct-home-10-eee",
          "other",
        ],
        [20],
      ),
    ).toEqual([
      "/tmp/bcct-capture-10-aaa",
      "/tmp/bcct-frames-10-bbb",
      "/tmp/bcct-board-10-ccc",
    ]);
    expect(removed).toEqual([
      "/tmp/bcct-capture-10-aaa",
      "/tmp/bcct-frames-10-bbb",
      "/tmp/bcct-board-10-ccc",
    ]);
  });

  it("stops the Chromium left running only when it uses that very profile", (): void => {
    files["/tmp/bcct-capture-10-aaa/chromium.pid"] = "555";
    files["/proc/555/cmdline"] =
      "chrome\0--headless=new\0--user-data-dir=/tmp/bcct-capture-10-aaa\0";
    files["/tmp/bcct-capture-11-bbb/chromium.pid"] = "556";
    files["/proc/556/cmdline"] = "bash\0";
    files["/tmp/bcct-capture-12-ccc/chromium.pid"] = "557";

    clean(
      ["bcct-capture-10-aaa", "bcct-capture-11-bbb", "bcct-capture-12-ccc"],
      [],
    );

    expect(killed).toEqual([555]);
    expect(removed).toHaveLength(3);
  });

  it("reads the command line Chromium rewrites with spaces in place of the separators", (): void => {
    files["/tmp/bcct-capture-10-aaa/chromium.pid"] = "555";
    files["/proc/555/cmdline"] =
      "/cache/chrome --headless=new --user-data-dir=/tmp/bcct-capture-10-aaa about:blank\0";

    clean(["bcct-capture-10-aaa"], []);

    expect(killed).toEqual([555]);
  });

  it("never stops a process for a profile that is a prefix of another one", (): void => {
    files["/tmp/bcct-capture-10-a/chromium.pid"] = "555";
    files["/proc/555/cmdline"] =
      "chrome\0--user-data-dir=/tmp/bcct-capture-10-ab\0";

    clean(["bcct-capture-10-a"], []);

    expect(killed).toEqual([]);
  });

  it("skips a folder it cannot remove and still removes the next ones", (): void => {
    const cleaned = cleanLeftovers("/tmp", {
      listDir: () => ["bcct-frames-10-locked", "bcct-frames-11-free"],
      isAlive: () => false,
      readText: () => null,
      kill: (pid) => killed.push(pid),
      remove: (path) => {
        if (path.endsWith("locked")) throw new Error("EACCES");

        removed.push(path);
      },
    });

    expect(cleaned).toEqual(["/tmp/bcct-frames-11-free"]);
    expect(removed).toEqual(["/tmp/bcct-frames-11-free"]);
  });

  it("stops nothing without a valid pid of Chromium", (): void => {
    files["/tmp/bcct-capture-10-aaa/chromium.pid"] = "0";
    files["/proc/0/cmdline"] = "--user-data-dir=/tmp/bcct-capture-10-aaa";

    clean(["bcct-capture-10-aaa"], []);

    expect(killed).toEqual([]);
  });

  describe("on the real disk", () => {
    let dir = "";

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "bcct-leftovers-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("removes the folder of a dead owner with its content and keeps the one of a live owner", (): void => {
      const dead = join(dir, "bcct-frames-999999999-x");
      const live = join(dir, `bcct-frames-${process.pid}-y`);

      mkdirSync(dead);
      writeFileSync(join(dead, "frame-0001.jpg"), "x");
      mkdirSync(live);

      expect(cleanLeftovers(dir)).toEqual([dead]);
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(live)).toBe(true);
    });

    it("finds nothing in a folder that does not exist", (): void => {
      expect(cleanLeftovers(join(dir, "missing"))).toEqual([]);
    });

    it("cleans the temporary folder of the system by default without touching live owners", (): void => {
      const live = mkdtempSync(join(tmpdir(), tempPrefix("board")));

      cleanLeftovers();

      expect(existsSync(live)).toBe(true);
      rmSync(live, { recursive: true, force: true });
    });
  });
});
