import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isCoverageTarget,
  parseChangedLines,
  uncoveredChangedLines,
} from "../coverage-changed-lines.mjs";

const ROOT = "/repo";
const COVERAGE = {
  include: ["plugins/telegram/extensions/**/*.ts"],
  exclude: ["**/__tests__/**"],
};
const EXTENSIONS = "plugins/telegram/extensions";

const DIFF = [
  `diff --git a/${EXTENSIONS}/a.ts b/${EXTENSIONS}/a.ts`,
  `--- a/${EXTENSIONS}/a.ts`,
  `+++ b/${EXTENSIONS}/a.ts`,
  "@@ -10,2 +10,3 @@ export function a() {",
  "-  old();",
  "-  older();",
  "+  one();",
  "+  two();",
  "+  three();",
  "@@ -20 +21 @@ export function a() {",
  "-  x();",
  "+  y();",
  "@@ -30,3 +31,0 @@ export function a() {",
  "-  gone();",
  "-  gone();",
  "-  gone();",
  `diff --git a/${EXTENSIONS}/b.ts b/${EXTENSIONS}/b.ts`,
  "new file mode 100644",
  "--- /dev/null",
  `+++ b/${EXTENSIONS}/b.ts`,
  "@@ -0,0 +1,2 @@",
  "+export const b = 1;",
  "+++ b/not-a-header.ts",
  "@@ -5 +6 @@",
  "+tail();",
  `diff --git a/${EXTENSIONS}/c.ts b/${EXTENSIONS}/c.ts`,
  "deleted file mode 100644",
  `--- a/${EXTENSIONS}/c.ts`,
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-export const c = 1;",
].join("\n");

function statement(line) {
  return { start: { line, column: 0 }, end: { line, column: null } };
}

function fileCoverage(file, hits) {
  const statementMap = {};
  const s = {};

  hits.forEach(([line, count], index) => {
    statementMap[String(index)] = statement(line);
    s[String(index)] = count;
  });

  return { path: file, statementMap, s };
}

describe("parseChangedLines", () => {
  it("lists the lines of the new side of each hunk, by file", () => {
    const changed = parseChangedLines(DIFF);

    expect([...changed.get(`${EXTENSIONS}/a.ts`)]).toEqual([10, 11, 12, 21]);
    expect([...changed.get(`${EXTENSIONS}/b.ts`)]).toEqual([1, 2, 6]);
  });

  it("skips a removal-only hunk, a deleted file and an added line that starts with ++", () => {
    const changed = parseChangedLines(DIFF);

    expect([...changed.keys()]).toEqual([
      `${EXTENSIONS}/a.ts`,
      `${EXTENSIONS}/b.ts`,
    ]);
    expect(changed.get(`${EXTENSIONS}/a.ts`).has(31)).toBe(false);
  });

  it("returns an empty map for an empty diff", () => {
    expect(parseChangedLines("").size).toBe(0);
  });
});

describe("isCoverageTarget follows the include and exclude of the coverage config", () => {
  it.each([`${EXTENSIONS}/i18n.ts`, `${EXTENSIONS}/media/download.ts`])(
    "counts %s",
    (file) => {
      expect(isCoverageTarget(file, COVERAGE)).toBe(true);
    },
  );

  it.each([
    `${EXTENSIONS}/__tests__/i18n.test.ts`,
    `${EXTENSIONS}/__tests__/support/fake-bot.ts`,
    `${EXTENSIONS}/i18n.test.ts`,
    `${EXTENSIONS}/i18n.spec.ts`,
    "plugins/telegram/server.ts",
    "plugins/telegram-hooks/telegram.mjs",
    "scripts/setup.mjs",
  ])("does not count %s", (file) => {
    expect(isCoverageTarget(file, COVERAGE)).toBe(false);
  });
});

describe("uncoveredChangedLines", () => {
  const coverage = {
    [`/repo/${EXTENSIONS}/a.ts`]: fileCoverage(`/repo/${EXTENSIONS}/a.ts`, [
      [10, 3],
      [11, 0],
      [11, 2],
      [11, 0],
      [12, 0],
      [40, 0],
    ]),
  };
  const options = { rootDir: ROOT, coverage: COVERAGE };

  it("points out the changed executable line no test ran", () => {
    const changed = new Map([[`${EXTENSIONS}/a.ts`, new Set([10, 11, 12])]]);

    expect(uncoveredChangedLines(changed, coverage, options)).toEqual({
      uncovered: [{ file: `${EXTENSIONS}/a.ts`, line: 12 }],
      missing: [],
    });
  });

  it("counts a line as covered when any statement on it ran", () => {
    const changed = new Map([[`${EXTENSIONS}/a.ts`, new Set([11])]]);

    expect(uncoveredChangedLines(changed, coverage, options).uncovered).toEqual(
      [],
    );
  });

  it("skips a changed line without a statement (type, brace, blank)", () => {
    const changed = new Map([[`${EXTENSIONS}/a.ts`, new Set([21])]]);

    expect(uncoveredChangedLines(changed, coverage, options).uncovered).toEqual(
      [],
    );
  });

  it("skips a changed file that is not a coverage target", () => {
    const changed = new Map([
      ["plugins/telegram/server.ts", new Set([1])],
      ["scripts/setup.mjs", new Set([1])],
    ]);

    expect(uncoveredChangedLines(changed, coverage, options)).toEqual({
      uncovered: [],
      missing: [],
    });
  });

  it("reports a target without coverage data instead of letting it through", () => {
    const changed = new Map([[`${EXTENSIONS}/new.ts`, new Set([1])]]);

    expect(uncoveredChangedLines(changed, coverage, options)).toEqual({
      uncovered: [],
      missing: [`${EXTENSIONS}/new.ts`],
    });
  });
});

describe("coverage-changed-lines.mjs", () => {
  const SCRIPT = join(import.meta.dirname, "..", "coverage-changed-lines.mjs");
  const ONE_MIB = 1024 * 1024;

  let repo;

  const write = (relativePath, content) => {
    const file = join(repo, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };

  const git = (...args) => {
    execFileSync(
      "git",
      [
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd: repo, stdio: "ignore" },
    );
  };

  const run = () =>
    spawnSync(process.execPath, [SCRIPT], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, COVERAGE_RANGE: "HEAD~1..HEAD" },
    });

  const coverageOf = (hits) =>
    write(
      "coverage/coverage-final.json",
      JSON.stringify({
        [join(repo, EXTENSIONS, "big.ts")]: fileCoverage(
          join(repo, EXTENSIONS, "big.ts"),
          hits,
        ),
      }),
    );

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "bcct-coverage-changed-")));
    git("init", "-q", "-b", "main");
    write(
      "vitest.config.ts",
      `export default { test: { coverage: { include: ["${EXTENSIONS}/**/*.ts"], exclude: ["**/__tests__/**"] } } };\n`,
    );
    write(`${EXTENSIONS}/big.ts`, "export const value = 0;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    write(
      `${EXTENSIONS}/big.ts`,
      `// ${"x".repeat(2 * ONE_MIB)}\nexport const value = 1;\n`,
    );
    git("add", "-A");
    git("commit", "-q", "-m", "big");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("reads a diff larger than the default Node buffer and passes when every changed executable line ran", () => {
    coverageOf([[2, 1]]);

    const result = run();

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Every executable line changed in this push runs in a test",
    );
  });

  it("fails with the file and line of a changed line that no test ran", () => {
    coverageOf([[2, 0]]);

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`  ${EXTENSIONS}/big.ts:2`);
  });

  it("fails when there is no coverage report, instead of letting the push through", () => {
    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("coverage/coverage-final.json not found");
  });
});
