import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeTestProgress } from "../test-progress.mjs";

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bcct-test-progress-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeTestProgress", () => {
  it("writes how many files ended and the total, for wait_step to build its line", () => {
    const file = join(dir, "progress");

    expect(writeTestProgress(file, 3, 10)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("3 10\n");
  });

  it("replaces the previous count", () => {
    const file = join(dir, "progress");

    writeTestProgress(file, 1, 4);
    writeTestProgress(file, 2, 4);

    expect(readFileSync(file, "utf8")).toBe("2 4\n");
  });

  it("leaves no temporary file behind", () => {
    writeTestProgress(join(dir, "progress"), 1, 4);

    expect(readdirSync(dir)).toEqual(["progress"]);
  });

  it("removes the temporary file when it cannot replace the target", () => {
    const target = join(dir, "progress");
    mkdirSync(join(target, "busy"), { recursive: true });

    expect(writeTestProgress(target, 1, 4)).toBe(false);
    expect(readdirSync(dir)).toEqual(["progress"]);
  });

  it("does not break the suite when the folder of the progress file is gone", () => {
    expect(writeTestProgress(join(dir, "missing", "progress"), 1, 4)).toBe(
      false,
    );
  });
});
