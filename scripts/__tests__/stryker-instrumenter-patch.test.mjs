import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const PACKAGE = "@stryker-mutator/instrumenter";
const PATCH_NAME = /^@stryker-mutator\+instrumenter\+(.+)\.patch$/u;
const PATCHED_FILE = /^\+\+\+ b\/(.+)$/mu;

function installedVersion() {
  const lock = JSON.parse(
    readFileSync(join(ROOT, "package-lock.json"), "utf8"),
  );

  return lock.packages[`node_modules/${PACKAGE}`].version;
}

function instrumenterPatches() {
  return readdirSync(join(ROOT, "patches")).filter((name) =>
    PATCH_NAME.test(name),
  );
}

describe("stryker instrumenter patch", () => {
  it("names the instrumenter version of the lock, so patch-package applies it", () => {
    expect(instrumenterPatches()).toEqual([
      `@stryker-mutator+instrumenter+${installedVersion()}.patch`,
    ]);
  });

  it("is applied to the installed instrumenter", () => {
    const [name] = instrumenterPatches();
    const patch = readFileSync(join(ROOT, "patches", name), "utf8");
    const file = PATCHED_FILE.exec(patch)?.[1] ?? "";
    const added = patch
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1));

    expect(file).toBe(
      "node_modules/@stryker-mutator/instrumenter/dist/src/mutators/conditional-expression-mutator.js",
    );
    expect(added).toContain(
      "    return ((parentPath.isIfStatement() || parentPath.isConditionalExpression()) &&",
    );

    const installed = readFileSync(join(ROOT, file), "utf8");

    for (const line of added) {
      expect(installed).toContain(line);
    }
  });
});
