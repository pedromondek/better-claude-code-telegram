import { describe, expect, it } from "vitest";

import {
  countSurvivors,
  ratchetBaseline,
  serializeBaseline,
} from "../mutation-baseline.mjs";

const SOURCE = [
  "class Svc {",
  "  method() {",
  "    this.logger.log('lifecycle');",
  "    if (id > 0) {",
  "      return 1;",
  "    }",
  "  }",
  "}",
].join("\n");

const mutant = (mutatorName, line, status = "Survived", extra = {}) => ({
  mutatorName,
  status,
  location: { start: { line } },
  coveredBy: ["t1"],
  ...extra,
});

const reportWith = (files) => ({
  files: Object.fromEntries(
    Object.entries(files).map(([file, mutants]) => [
      file,
      { source: SOURCE, mutants },
    ]),
  ),
});

describe("countSurvivors", () => {
  it("counts per mutator only the measured Survived that are not log text", () => {
    const report = reportWith({
      "src/svc.ts": [
        mutant("ConditionalExpression", 4),
        mutant("ConditionalExpression", 4),
        mutant("EqualityOperator", 4),
        mutant("StringLiteral", 3),
        mutant("ConditionalExpression", 4, "Killed"),
        mutant("ConditionalExpression", 4, "NoCoverage"),
        mutant("EqualityOperator", 4, "Survived", { testsCompleted: 0 }),
      ],
    });

    expect(countSurvivors(report, "src/svc.ts")).toEqual({
      ConditionalExpression: 2,
      EqualityOperator: 1,
    });
  });

  it("returns empty for a file outside the report", () => {
    expect(countSurvivors(reportWith({}), "src/x.ts")).toEqual({});
  });
});

describe("ratchetBaseline", () => {
  it("only lowers the numbers of the mutated files and drops the mutator and the file that reached zero", () => {
    const baseline = {
      "src/svc.ts": { ConditionalExpression: 3, EqualityOperator: 1 },
      "src/clean.ts": { BooleanLiteral: 2 },
      "src/outside.ts": { StringLiteral: 4 },
    };
    const report = reportWith({
      "src/svc.ts": [mutant("ConditionalExpression", 4)],
      "src/clean.ts": [],
    });

    expect(ratchetBaseline(baseline, report)).toEqual({
      "src/outside.ts": { StringLiteral: 4 },
      "src/svc.ts": { ConditionalExpression: 1 },
    });
  });

  it("never raises a number nor records a new file without explicit acceptance", () => {
    const baseline = { "src/svc.ts": { ConditionalExpression: 1 } };
    const report = reportWith({
      "src/svc.ts": [
        mutant("ConditionalExpression", 4),
        mutant("ConditionalExpression", 4),
        mutant("EqualityOperator", 4),
      ],
      "src/new.ts": [mutant("ConditionalExpression", 4)],
    });

    expect(ratchetBaseline(baseline, report)).toEqual({
      "src/svc.ts": { ConditionalExpression: 1 },
    });
  });

  it("records the current count of the accepted files, including a new file and a higher number", () => {
    const baseline = { "src/svc.ts": { ConditionalExpression: 1 } };
    const report = reportWith({
      "src/svc.ts": [
        mutant("ConditionalExpression", 4),
        mutant("EqualityOperator", 4),
      ],
      "src/new.ts": [mutant("BooleanLiteral", 4)],
      "src/other.ts": [mutant("BooleanLiteral", 4)],
    });

    expect(
      ratchetBaseline(baseline, report, {
        accept: ["src/svc.ts", "src/new.ts"],
      }),
    ).toEqual({
      "src/new.ts": { BooleanLiteral: 1 },
      "src/svc.ts": { ConditionalExpression: 1, EqualityOperator: 1 },
    });
  });

  it("does not record an accepted file that has no survivor", () => {
    const report = reportWith({ "src/clean.ts": [] });

    expect(ratchetBaseline({}, report, { accept: ["src/clean.ts"] })).toEqual(
      {},
    );
  });
});

describe("serializeBaseline", () => {
  it("sorts files and mutators and ends with a line break, so the diff stays stable", () => {
    const text = serializeBaseline({
      "src/b.ts": { Z: 1, A: 2 },
      "src/a.ts": { M: 3 },
    });

    expect(text).toBe(
      '{\n  "src/a.ts": {\n    "M": 3\n  },\n  "src/b.ts": {\n    "A": 2,\n    "Z": 1\n  }\n}\n',
    );
  });
});
