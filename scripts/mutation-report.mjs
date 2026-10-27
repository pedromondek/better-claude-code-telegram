const LOG_TEXT_MUTATORS = new Set([
  "StringLiteral",
  "CallExpression",
  "ObjectLiteral",
]);
const LOGGER_CALL = /\.logger\.(log|warn|error|debug|verbose|fatal)\s*\(/;

export const MutantClass = Object.freeze({
  UNMEASURED: "UNMEASURED",
  LOG: "LOG",
  REAL: "REAL",
  NOCOV: "NOCOV",
});

const FINDING_LABEL = {
  [MutantClass.UNMEASURED]: "Survived (unmeasured)",
  [MutantClass.LOG]: "Survived (log)",
  [MutantClass.REAL]: "Survived",
  [MutantClass.NOCOV]: "NoCoverage",
};

export function isLoggerTextMutant(mutant, sourceLines) {
  if (!LOG_TEXT_MUTATORS.has(mutant.mutatorName)) return false;
  const line = mutant.location?.start?.line;
  if (!line) return false;
  const current = sourceLines[line - 1] ?? "";
  if (LOGGER_CALL.test(current)) return true;
  const previous = (sourceLines[line - 2] ?? "").trimEnd();
  return LOGGER_CALL.test(previous) && previous.endsWith("(");
}

export function classifyMutant(mutant, sourceLines) {
  if (mutant.status === "NoCoverage") return MutantClass.NOCOV;
  if (mutant.status !== "Survived") return null;
  if (mutant.testsCompleted === 0) return MutantClass.UNMEASURED;
  if (isLoggerTextMutant(mutant, sourceLines)) return MutantClass.LOG;
  return MutantClass.REAL;
}

function percent(detected, total) {
  return total === 0 ? "—" : `${((100 * detected) / total).toFixed(1)}%`;
}

export function scoreMutants(mutants, sourceLines) {
  const counts = { Killed: 0, Timeout: 0, Survived: 0, NoCoverage: 0 };
  const findings = [];
  let logSurvived = 0;
  let unmeasured = 0;

  for (const mutant of mutants) {
    counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;

    const mutantClass = classifyMutant(mutant, sourceLines);
    if (!mutantClass) continue;

    if (mutantClass === MutantClass.LOG) logSurvived++;
    if (mutantClass === MutantClass.UNMEASURED) unmeasured++;

    findings.push({
      mutantClass,
      line: mutant.location.start.line,
      mutator: mutant.mutatorName,
      replacement: String(mutant.replacement ?? "").slice(0, 70),
    });
  }

  const detected = counts.Killed + counts.Timeout;

  return {
    total: mutants.length,
    detected,
    survived: counts.Survived,
    logSurvived,
    unmeasured,
    noCoverage: counts.NoCoverage,
    raw: percent(detected, detected + counts.Survived + counts.NoCoverage),
    covered: percent(detected, detected + counts.Survived),
    effective: percent(detected, detected + counts.Survived - logSurvived),
    findings,
  };
}

export function scoreFile(report, file, { start, end } = {}) {
  const fileReport = report.files?.[file];
  if (!fileReport) return null;

  const mutants = fileReport.mutants.filter((mutant) => {
    const line = mutant.location.start.line;
    return (
      (start === undefined || line >= start) &&
      (end === undefined || line <= end)
    );
  });

  return scoreMutants(mutants, (fileReport.source ?? "").split("\n"));
}

export function formatScore(label, score) {
  if (!score) return [`${label} | no mutants in the report`];

  const survivedDetail =
    score.unmeasured > 0
      ? `log ${score.logSurvived}, unmeasured ${score.unmeasured}`
      : `log ${score.logSurvived}`;

  return [
    `${label} | ${score.total} mutants | killed ${score.detected} | survived ${score.survived} (${survivedDetail}) | nocov ${score.noCoverage} | raw ${score.raw} | covered ${score.covered} | effective ${score.effective}`,
    ...score.findings.map(
      (finding) =>
        `  ${FINDING_LABEL[finding.mutantClass]} L${finding.line} ${finding.mutator} -> ${finding.replacement}`,
    ),
  ];
}
