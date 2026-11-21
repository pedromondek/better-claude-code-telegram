import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  classifyMutant,
  formatScore,
  isLoggerTextMutant,
  MutantClass,
  scoreFile,
  scoreMutants,
} from "../mutation-report.mjs";

const SOURCE = [
  "class Svc {",
  "  method() {",
  "    this.logger.log('lifecycle', { count: n });",
  "    this.logger.error(",
  "      `Error ${id}`,",
  "    );",
  "    const url = 'https://api.example.com';",
  "    if (id > 0) {",
  "      return url;",
  "    }",
  "    this.logger.warn('end');",
  "    const label = 'x';",
  "  }",
  "}",
].join("\n");
const LINES = SOURCE.split("\n");

const REPORT = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "fixtures", "mutation-report.json"),
    "utf8",
  ),
);

const mutant = (mutatorName, line, extra = {}) => ({
  mutatorName,
  status: "Survived",
  testsCompleted: 1,
  location: { start: { line } },
  ...extra,
});

describe("isLoggerTextMutant", () => {
  it("filters a message StringLiteral in a single-line this.logger.*", () => {
    expect(isLoggerTextMutant(mutant("StringLiteral", 3), LINES)).toBe(true);
  });

  it("filters an ObjectLiteral of params on the logger's own line", () => {
    expect(isLoggerTextMutant(mutant("ObjectLiteral", 3), LINES)).toBe(true);
  });

  it("filters a CallExpression (call removal) on the logger line", () => {
    expect(isLoggerTextMutant(mutant("CallExpression", 11), LINES)).toBe(true);
  });

  it("filters the template StringLiteral when the line above opens this.logger.x(", () => {
    expect(isLoggerTextMutant(mutant("StringLiteral", 5), LINES)).toBe(true);
  });

  it("does not filter a StringLiteral outside a log", () => {
    expect(isLoggerTextMutant(mutant("StringLiteral", 7), LINES)).toBe(false);
  });

  it("does not filter a StringLiteral whose line above is an already closed logger", () => {
    expect(isLoggerTextMutant(mutant("StringLiteral", 12), LINES)).toBe(false);
  });

  it("does not filter a behavior mutator near a log", () => {
    expect(isLoggerTextMutant(mutant("ConditionalExpression", 8), LINES)).toBe(
      false,
    );
  });

  it("does not filter a mutant without a start line", () => {
    expect(
      isLoggerTextMutant({ mutatorName: "StringLiteral", location: {} }, LINES),
    ).toBe(false);
  });
});

describe("classifyMutant", () => {
  it("classifies a text Survived on a this.logger.* line as LOG", () => {
    expect(classifyMutant(mutant("StringLiteral", 3), LINES)).toBe(
      MutantClass.LOG,
    );
  });

  it("classifies a Survived outside a log as REAL", () => {
    expect(classifyMutant(mutant("ConditionalExpression", 8), LINES)).toBe(
      MutantClass.REAL,
    );
  });

  it("classifies NoCoverage as NOCOV, even on a log line", () => {
    expect(
      classifyMutant(
        mutant("StringLiteral", 3, { status: "NoCoverage" }),
        LINES,
      ),
    ).toBe(MutantClass.NOCOV);
  });

  it("classifies a Survived with testsCompleted 0 as UNMEASURED before the log filter", () => {
    expect(
      classifyMutant(mutant("StringLiteral", 3, { testsCompleted: 0 }), LINES),
    ).toBe(MutantClass.UNMEASURED);
  });

  it("does not classify a Survived without the testsCompleted field as UNMEASURED", () => {
    expect(
      classifyMutant(
        mutant("ConditionalExpression", 8, { testsCompleted: undefined }),
        LINES,
      ),
    ).toBe(MutantClass.REAL);
  });

  it("returns null for a detected, invalid or ignored mutant", () => {
    for (const status of [
      "Killed",
      "Timeout",
      "CompileError",
      "RuntimeError",
      "Ignored",
    ]) {
      expect([
        status,
        classifyMutant(mutant("StringLiteral", 7, { status }), LINES),
      ]).toEqual([status, null]);
    }
  });
});

describe("scoreMutants", () => {
  it("computes raw, covered and effective by Stryker's formulas, with the log out of the effective", () => {
    const score = scoreFile(REPORT, "src/svc.ts");

    expect({
      total: score.total,
      detected: score.detected,
      survived: score.survived,
      logSurvived: score.logSurvived,
      unmeasured: score.unmeasured,
      noCoverage: score.noCoverage,
      raw: score.raw,
      covered: score.covered,
      effective: score.effective,
    }).toEqual({
      total: 8,
      detected: 3,
      survived: 3,
      logSurvived: 1,
      unmeasured: 1,
      noCoverage: 1,
      raw: "42.9%",
      covered: "50.0%",
      effective: "60.0%",
    });
  });

  it("lists Survived and NoCoverage in report order with the class, line, mutator and replacement", () => {
    expect(scoreFile(REPORT, "src/svc.ts").findings).toEqual([
      {
        mutantClass: MutantClass.LOG,
        line: 3,
        mutator: "StringLiteral",
        replacement: '""',
      },
      {
        mutantClass: MutantClass.REAL,
        line: 8,
        mutator: "ConditionalExpression",
        replacement: "true",
      },
      {
        mutantClass: MutantClass.NOCOV,
        line: 5,
        mutator: "StringLiteral",
        replacement: '""',
      },
      {
        mutantClass: MutantClass.UNMEASURED,
        line: 7,
        mutator: "StringLiteral",
        replacement: '""',
      },
    ]);
  });

  it("cuts the replacement at 70 characters and accepts a mutant without replacement", () => {
    const { findings } = scoreMutants(
      [
        mutant("ConditionalExpression", 8, { replacement: "x".repeat(80) }),
        mutant("ConditionalExpression", 8),
      ],
      LINES,
    );

    expect(findings.map(({ replacement }) => replacement)).toEqual([
      "x".repeat(70),
      "",
    ]);
  });

  it("returns a dash in all three scores when there is no valid mutant", () => {
    const score = scoreMutants(
      [mutant("StringLiteral", 7, { status: "Ignored" })],
      LINES,
    );

    expect([score.raw, score.covered, score.effective]).toEqual([
      "—",
      "—",
      "—",
    ]);
  });
});

describe("scoreFile", () => {
  it("considers only the mutants that start inside the line range", () => {
    const score = scoreFile(REPORT, "src/svc.ts", { start: 4, end: 5 });

    expect([
      score.total,
      score.detected,
      score.noCoverage,
      score.raw,
      score.covered,
    ]).toEqual([3, 2, 1, "66.7%", "100.0%"]);
  });

  it("returns null when the file is not in the report", () => {
    expect(scoreFile(REPORT, "src/missing.ts")).toBeNull();
  });
});

describe("formatScore", () => {
  it("only shows the unmeasured count when there is one", () => {
    const [header] = formatScore(
      "src/svc.ts:1-6",
      scoreFile(REPORT, "src/svc.ts", { start: 1, end: 6 }),
    );

    expect(header).toMatch(/survived 1 \(log 1\) \|/);
  });

  it("warns when the file has no mutants in the report", () => {
    expect(formatScore("src/missing.ts", null)).toEqual([
      "src/missing.ts | no mutants in the report",
    ]);
  });
});
