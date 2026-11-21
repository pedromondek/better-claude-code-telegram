import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import VitestProgressReporter from "../vitest-progress-reporter.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const REPORTER = join(ROOT, "scripts", "vitest-progress-reporter.mjs");
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");

let dir;
let file;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bcct-vitest-progress-"));
  file = join(dir, "progress");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("VitestProgressReporter", () => {
  it("announces the number of files as soon as the run starts", () => {
    new VitestProgressReporter({ file }).onTestRunStart([{}, {}, {}, {}]);

    expect(readFileSync(file, "utf8")).toBe("0 4\n");
  });

  it("moves one file forward at each test module that ends", () => {
    const reporter = new VitestProgressReporter({ file });

    reporter.onTestRunStart([{}, {}, {}, {}]);
    reporter.onTestModuleEnd({});
    reporter.onTestModuleEnd({});

    expect(readFileSync(file, "utf8")).toBe("2 4\n");
  });

  it("with the empty options Vitest gives the constructor, reads the file from TEST_PROGRESS_FILE", () => {
    vi.stubEnv("TEST_PROGRESS_FILE", file);

    new VitestProgressReporter({}).onTestRunStart([{}]);

    expect(readFileSync(file, "utf8")).toBe("0 1\n");
  });

  it("writes nothing without a progress file", () => {
    vi.stubEnv("TEST_PROGRESS_FILE", undefined);

    const reporter = new VitestProgressReporter({});
    reporter.onTestRunStart([{}]);
    reporter.onTestModuleEnd({});

    expect(readdirSync(dir)).toEqual([]);
  });

  it("in a real Vitest run, writes the total and ends with every file", () => {
    const root = join(dir, "root");
    const passing = 'test("passes", () => {});\n';
    mkdirSync(root);
    writeFileSync(join(root, "a.test.mjs"), passing);
    writeFileSync(join(root, "b.test.mjs"), passing);

    const result = spawnSync(
      process.execPath,
      [
        VITEST,
        "run",
        "--root",
        root,
        "--globals",
        "--reporter=minimal",
        `--reporter=${REPORTER}`,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, TEST_PROGRESS_FILE: file },
      },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("2 2\n");
    expect(readdirSync(root).filter((entry) => entry.endsWith(".tmp"))).toEqual(
      [],
    );
  }, 30_000);
});
