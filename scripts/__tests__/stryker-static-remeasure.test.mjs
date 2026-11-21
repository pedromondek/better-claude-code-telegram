import { describe, expect, it } from "vitest";

import {
  hybridSurvivors,
  mergeRemeasured,
  remeasureConfig,
  remeasureHybridSurvivors,
  remeasureMutate,
  STATIC_REMEASURE_CONFIG,
  STATIC_REMEASURE_REPORT,
} from "../stryker-static-remeasure.mjs";

const location = (line, column = 7, endColumn = 15) => ({
  start: { line, column },
  end: { line, column: endColumn },
});

const mutant = (overrides) => ({
  id: "1",
  mutatorName: "StringLiteral",
  replacement: '""',
  status: "Survived",
  static: true,
  coveredBy: ["data-source.spec.ts#loads the .env"],
  testsCompleted: 5,
  location: location(1),
  ...overrides,
});

const report = (files) => ({
  files: Object.fromEntries(
    Object.entries(files).map(([file, mutants]) => [
      file,
      { source: "", mutants },
    ]),
  ),
});

describe("hybridSurvivors", () => {
  it("lists only the Survived marked as static, from all files", () => {
    const hybrid = mutant({ id: "1" });
    const lateHybrid = mutant({ id: "4", location: location(9) });

    expect(
      hybridSurvivors(
        report({
          "src/a.ts": [
            hybrid,
            mutant({ id: "2", static: false }),
            mutant({ id: "3", status: "Killed" }),
          ],
          "src/b.ts": [lateHybrid],
        }),
      ),
    ).toEqual([
      { file: "src/a.ts", mutant: hybrid },
      { file: "src/b.ts", mutant: lateHybrid },
    ]);
  });

  it("returns an empty list when the report has no files", () => {
    expect(hybridSurvivors({})).toEqual([]);
  });
});

describe("remeasureMutate", () => {
  it("builds one line range per mutant, without repeats and in order", () => {
    expect(
      remeasureMutate([
        { file: "src/b.ts", mutant: mutant({ location: location(3) }) },
        { file: "src/a.ts", mutant: mutant({ location: location(11) }) },
        { file: "src/a.ts", mutant: mutant({ location: location(11, 20) }) },
        {
          file: "src/a.ts",
          mutant: mutant({
            location: {
              start: { line: 4, column: 1 },
              end: { line: 6, column: 2 },
            },
          }),
        },
      ]),
    ).toEqual(["src/a.ts:11-11", "src/a.ts:4-6", "src/b.ts:3-3"]);
  });
});

describe("remeasureConfig", () => {
  it("runs the static ones with all tests, without incremental, one runner and its own report", () => {
    const base = {
      testRunner: "vitest",
      vitest: { configFile: "vitest.config.mts" },
      mutate: ["src/**/*.ts"],
      ignoreStatic: true,
      incremental: true,
      incrementalFile: "reports/stryker-incremental.json",
      reporters: ["clear-text", "html", "json"],
      jsonReporter: { fileName: "reports/mutation/report.json" },
    };

    expect(remeasureConfig(base, ["src/a.ts:11-11"])).toEqual({
      testRunner: "vitest",
      vitest: { configFile: "vitest.config.mts" },
      mutate: ["src/a.ts:11-11"],
      ignoreStatic: false,
      incremental: false,
      incrementalFile: "reports/stryker-incremental.json",
      reporters: ["json"],
      jsonReporter: { fileName: STATIC_REMEASURE_REPORT },
      concurrency: 1,
      warnings: { slow: false },
    });
  });

  it("drops testFiles from the config so the static mutant is activated before the module loads", () => {
    const config = remeasureConfig(
      { mutate: ["src/**/*.ts"], testFiles: ["src/__tests__/a.spec.ts"] },
      ["src/a.ts:11-11"],
    );

    expect("testFiles" in config).toBe(false);
  });
});

describe("mergeRemeasured", () => {
  it("replaces the hybrid's result with the static measurement's and keeps the original coveredBy", () => {
    const original = report({
      "src/a.ts": [
        mutant({ id: "1" }),
        mutant({ id: "2", status: "Killed", static: false }),
      ],
    });
    const remeasured = report({
      "src/a.ts": [
        mutant({
          id: "90",
          status: "Killed",
          statusReason: "expected '' to be 'gpt-4o'",
          killedBy: ["ai.util.spec.ts#uses a default model"],
          coveredBy: [],
          testsCompleted: 118,
        }),
      ],
    });

    const merged = mergeRemeasured(original, remeasured);

    expect(merged.files["src/a.ts"].mutants).toEqual([
      mutant({
        id: "1",
        status: "Killed",
        statusReason: "expected '' to be 'gpt-4o'",
        killedBy: ["ai.util.spec.ts#uses a default model"],
        testsCompleted: 118,
      }),
      mutant({ id: "2", status: "Killed", static: false }),
    ]);
    expect(original.files["src/a.ts"].mutants[0].status).toBe("Survived");
  });

  it("matches by mutator, replacement and exact position", () => {
    const original = report({
      "src/a.ts": [mutant({ id: "1", location: location(11, 7, 15) })],
    });
    const remeasured = report({
      "src/a.ts": [
        mutant({ status: "Killed", location: location(11, 20, 28) }),
        mutant({ status: "Killed", replacement: '"Stryker was here!"' }),
        mutant({ status: "Killed", mutatorName: "ObjectLiteral" }),
      ],
    });

    expect(
      mergeRemeasured(original, remeasured).files["src/a.ts"].mutants[0].status,
    ).toBe("Survived");
  });

  it("keeps Survived when the static measurement does not kill it either", () => {
    const original = report({ "src/a.ts": [mutant({ id: "1" })] });
    const remeasured = report({
      "src/a.ts": [mutant({ status: "Survived", testsCompleted: 118 })],
    });

    const [merged] = mergeRemeasured(original, remeasured).files["src/a.ts"]
      .mutants;

    expect(merged.status).toBe("Survived");
    expect(merged.testsCompleted).toBe(118);
  });
});

describe("remeasureHybridSurvivors", () => {
  const base = { mutate: ["src/**/*.ts"], ignoreStatic: true };

  it("does not run Stryker when no survivor is static", async () => {
    const original = report({
      "src/a.ts": [mutant({ static: false })],
    });
    const calls = [];

    const result = await remeasureHybridSurvivors(original, {
      baseConfig: base,
      runStryker: async (args) => {
        calls.push(args);
        return 0;
      },
      readJson: () => expect.fail("should not read a report"),
      writeJson: () => expect.fail("should not write a config"),
    });

    expect(calls).toEqual([]);
    expect(result).toEqual({ report: original, remeasured: 0, status: 0 });
  });

  it("writes the config, runs Stryker on it and returns the report with the measured result", async () => {
    const original = report({ "src/a.ts": [mutant({ id: "1" })] });
    const written = [];
    const calls = [];

    const result = await remeasureHybridSurvivors(original, {
      baseConfig: base,
      runStryker: async (args) => {
        calls.push(args);
        return 0;
      },
      readJson: (file) => {
        expect(file).toBe(STATIC_REMEASURE_REPORT);
        return report({ "src/a.ts": [mutant({ status: "Killed" })] });
      },
      writeJson: (file, content) => written.push([file, content]),
    });

    expect(written).toEqual([
      [STATIC_REMEASURE_CONFIG, remeasureConfig(base, ["src/a.ts:1-1"])],
    ]);
    expect(calls).toEqual([
      ["run", STATIC_REMEASURE_CONFIG, "--logLevel", "warn"],
    ]);
    expect(result.remeasured).toBe(1);
    expect(result.status).toBe(0);
    expect(result.report.files["src/a.ts"].mutants[0].status).toBe("Killed");
  });

  it("returns the original report and Stryker's exit code when the measurement fails", async () => {
    const original = report({ "src/a.ts": [mutant({ id: "1" })] });

    const result = await remeasureHybridSurvivors(original, {
      baseConfig: base,
      runStryker: async () => 2,
      readJson: () => expect.fail("should not read a report"),
      writeJson: () => {},
    });

    expect(result).toEqual({ report: original, remeasured: 1, status: 2 });
  });
});
