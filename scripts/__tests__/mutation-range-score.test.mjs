import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "mutation-range-score.mjs");
const REPORT = join(import.meta.dirname, "fixtures", "mutation-report.json");

function score(...args) {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [SCRIPT, ...args],
    { cwd: ROOT, encoding: "utf8" },
  );

  return { status, stdout: stdout.split("\n").filter(Boolean), stderr };
}

describe("mutation-range-score › output per range", () => {
  it("prints raw, covered and effective for each range and lists Survived and NoCoverage with the log text marked", () => {
    const { status, stdout } = score(
      "src/svc.ts:1-6,src/svc.ts:8-10,src/svc.ts:9-10,src/missing.ts:1-2",
      REPORT,
    );

    expect(status).toBe(0);
    expect(stdout).toEqual([
      "src/svc.ts:1-6 | 4 mutants | killed 2 | survived 1 (log 1) | nocov 1 | raw 50.0% | covered 66.7% | effective 100.0%",
      '  Survived (log) L3 StringLiteral -> ""',
      '  NoCoverage L5 StringLiteral -> ""',
      "src/svc.ts:8-10 | 3 mutants | killed 1 | survived 1 (log 0) | nocov 0 | raw 50.0% | covered 50.0% | effective 50.0%",
      "  Survived L8 ConditionalExpression -> true",
      "src/svc.ts:9-10 | 0 mutants | killed 0 | survived 0 (log 0) | nocov 0 | raw — | covered — | effective —",
      "src/missing.ts:1-2 | no mutants in the report",
    ]);
  });

  it("marks as unmeasured the Survived with testsCompleted 0 on a log line and keeps it in the effective", () => {
    const { status, stdout } = score("src/svc.ts:1-10", REPORT);

    expect(status).toBe(0);
    expect(stdout).toEqual([
      "src/svc.ts:1-10 | 8 mutants | killed 3 | survived 3 (log 1, unmeasured 1) | nocov 1 | raw 42.9% | covered 50.0% | effective 60.0%",
      '  Survived (log) L3 StringLiteral -> ""',
      "  Survived L8 ConditionalExpression -> true",
      '  NoCoverage L5 StringLiteral -> ""',
      '  Survived (unmeasured) L7 StringLiteral -> ""',
    ]);
  });
});

describe("mutation-range-score › invalid input", () => {
  it("exits with code 1 and shows the usage when no range is passed", () => {
    const { status, stdout, stderr } = score();

    expect(status).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toMatch(
      /usage: npm run test:mutation:score -- "file:start-end,file:start-end"/,
    );
  });

  it("exits with code 1 when the report does not exist", () => {
    const missing = join(
      import.meta.dirname,
      "fixtures",
      "does-not-exist.json",
    );
    const { status, stderr } = score("src/svc.ts:1-2", missing);

    expect(status).toBe(1);
    expect(stderr).toMatch(new RegExp(`report not found: ${missing}`));
  });

  it("exits with code 1 and points at the range when it has no numeric start and end", () => {
    const { status, stdout, stderr } = score("src/svc.ts:abc", REPORT);

    expect(status).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toMatch(
      /invalid range: src\/svc\.ts:abc \(use file:start-end\)/,
    );
  });
});
