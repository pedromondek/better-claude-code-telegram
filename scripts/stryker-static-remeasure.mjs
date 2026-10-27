import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { STRYKER_TEMP_ROOT } from "./stryker-run.mjs";

export const STATIC_REMEASURE_CONFIG = path.join(
  STRYKER_TEMP_ROOT,
  "static-remeasure.config.json",
);
export const STATIC_REMEASURE_REPORT = "reports/mutation/static-remeasure.json";

const MEASURED_FIELDS = [
  "status",
  "statusReason",
  "killedBy",
  "testsCompleted",
];

export function hybridSurvivors(report) {
  return Object.entries(report.files ?? {}).flatMap(([file, fileReport]) =>
    fileReport.mutants
      .filter((mutant) => mutant.status === "Survived" && mutant.static)
      .map((mutant) => ({ file, mutant })),
  );
}

export function remeasureMutate(survivors) {
  const ranges = survivors.map(
    ({ file, mutant }) =>
      `${file}:${mutant.location.start.line}-${mutant.location.end.line}`,
  );

  return [...new Set(ranges)].toSorted();
}

export function remeasureConfig(baseConfig, mutate) {
  const { testFiles: _testFiles, ...config } = baseConfig;

  return {
    ...config,
    mutate,
    ignoreStatic: false,
    incremental: false,
    reporters: ["json"],
    jsonReporter: { fileName: STATIC_REMEASURE_REPORT },
    concurrency: 1,
    warnings: { slow: false },
  };
}

function samePosition(a, b) {
  return (
    a.mutatorName === b.mutatorName &&
    a.replacement === b.replacement &&
    a.location.start.line === b.location.start.line &&
    a.location.start.column === b.location.start.column &&
    a.location.end.line === b.location.end.line &&
    a.location.end.column === b.location.end.column
  );
}

export function mergeRemeasured(report, remeasured) {
  const files = Object.fromEntries(
    Object.entries(report.files ?? {}).map(([file, fileReport]) => {
      const measured = remeasured.files?.[file]?.mutants ?? [];
      const mutants = fileReport.mutants.map((mutant) => {
        if (mutant.status !== "Survived" || !mutant.static) return mutant;

        const match = measured.find((candidate) =>
          samePosition(candidate, mutant),
        );
        if (!match) return mutant;

        const result = { ...mutant };
        for (const field of MEASURED_FIELDS) {
          if (field in match) result[field] = match[field];
        }
        return result;
      });

      return [file, { ...fileReport, mutants }];
    }),
  );

  return { ...report, files };
}

export function readJsonFile(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeJsonFile(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(content));
}

export async function remeasureHybridSurvivors(
  report,
  { baseConfig, runStryker, readJson, writeJson },
) {
  const survivors = hybridSurvivors(report);
  if (survivors.length === 0) return { report, remeasured: 0, status: 0 };

  writeJson(
    STATIC_REMEASURE_CONFIG,
    remeasureConfig(baseConfig, remeasureMutate(survivors)),
  );
  const status = await runStryker([
    "run",
    STATIC_REMEASURE_CONFIG,
    "--logLevel",
    "warn",
  ]);
  if (status !== 0) {
    return { report, remeasured: survivors.length, status };
  }

  return {
    report: mergeRemeasured(report, readJson(STATIC_REMEASURE_REPORT)),
    remeasured: survivors.length,
    status,
  };
}
