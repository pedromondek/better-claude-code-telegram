import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { classifyMutant, MutantClass } from "./mutation-report.mjs";

export const BASELINE_FILE = "mutation-baseline.json";
const REPORT_FILE = "reports/mutation/report.json";

export function readBaseline(file, { exists = existsSync } = {}) {
  if (!exists(file)) return {};

  return JSON.parse(readFileSync(file, "utf8"));
}

export function countSurvivors(report, file) {
  const fileReport = report.files?.[file];
  const sourceLines = (fileReport?.source ?? "").split("\n");
  const counts = {};

  for (const mutant of fileReport?.mutants ?? []) {
    if (mutant.status !== "Survived") continue;
    if (classifyMutant(mutant, sourceLines) !== MutantClass.REAL) continue;

    counts[mutant.mutatorName] = (counts[mutant.mutatorName] ?? 0) + 1;
  }

  return counts;
}

function lowered(previous, current) {
  const result = {};

  for (const [mutatorName, allowed] of Object.entries(previous)) {
    const count = Math.min(allowed, current[mutatorName] ?? 0);
    if (count > 0) result[mutatorName] = count;
  }

  return result;
}

export function ratchetBaseline(baseline, report, { accept = [] } = {}) {
  const next = { ...baseline };
  const accepted = new Set(accept);

  for (const file of Object.keys(report.files ?? {})) {
    const current = countSurvivors(report, file);
    const entry = accepted.has(file)
      ? current
      : lowered(baseline[file] ?? {}, current);

    if (Object.keys(entry).length > 0) {
      next[file] = entry;
    } else {
      delete next[file];
    }
  }

  return next;
}

export function serializeBaseline(baseline) {
  const sorted = Object.fromEntries(
    Object.keys(baseline)
      .toSorted()
      .map((file) => [
        file,
        Object.fromEntries(
          Object.keys(baseline[file])
            .toSorted()
            .map((mutatorName) => [mutatorName, baseline[file][mutatorName]]),
        ),
      ]),
  );

  return `${JSON.stringify(sorted, null, 2)}\n`;
}

function main() {
  const acceptIndex = process.argv.indexOf("--accept");
  const accept = acceptIndex === -1 ? [] : process.argv.slice(acceptIndex + 1);

  let report;
  try {
    report = JSON.parse(readFileSync(REPORT_FILE, "utf8"));
  } catch {
    console.error(
      `Report ${REPORT_FILE} not found: run Stryker on the files first.`,
    );
    process.exitCode = 1;
    return;
  }

  const missing = accept.filter((file) => !report.files?.[file]);
  if (missing.length > 0) {
    console.error(
      `Accepted file outside the last Stryker report: ${missing.join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  const before = serializeBaseline(readBaseline(BASELINE_FILE));
  const after = serializeBaseline(
    ratchetBaseline(readBaseline(BASELINE_FILE), report, { accept }),
  );

  if (before === after) {
    console.log(`${BASELINE_FILE} unchanged.`);
    return;
  }

  writeFileSync(BASELINE_FILE, after);
  console.log(
    `${BASELINE_FILE} updated (check the diff: it only goes down, except for an accepted file).`,
  );
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main();
}
