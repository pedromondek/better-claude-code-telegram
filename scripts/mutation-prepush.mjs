import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseChangedLines } from "./coverage-changed-lines.mjs";
import { git } from "./git.mjs";
import { BASELINE_FILE, readBaseline } from "./mutation-baseline.mjs";
import { classifyMutant, MutantClass } from "./mutation-report.mjs";
import { pushRange } from "./push-range.mjs";
import { runStryker } from "./stryker-run.mjs";
import {
  readJsonFile,
  remeasureHybridSurvivors,
  writeJsonFile,
} from "./stryker-static-remeasure.mjs";

const SOURCE_ROOT = "plugins/telegram/extensions";
const SPEC_SUFFIX = /\.test\.[cm]?[jt]sx?$/;
const TEST_SUPPORT =
  /^(vitest\.setup\.[^/]+|plugins\/telegram\/extensions\/__tests__\/.+)$/;
const E2E_SPEC = /\.e2e\.test\.[cm]?[jt]sx?$/;
const FULL_RUN_TRIGGER =
  /^(package(-lock)?\.json|stryker\.config\.json|vitest\.config[^/]*\.m?ts|patches\/.+)$/;
const SOURCE_EXTENSIONS = [".ts", ".tsx"];

function layerPrefix(layer) {
  return layer === "" ? "" : `${layer}/`;
}

function run(args) {
  try {
    return git(args);
  } catch {
    return "";
  }
}

function changedFiles() {
  return run(["diff", "--name-only", "--diff-filter=ACMR", pushRange()])
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
}

export function toLayerChangedLines(changedByRepoPath, layer) {
  const prefix = layerPrefix(layer);
  const byLayerPath = new Map();

  for (const [repoPath, lines] of changedByRepoPath) {
    if (repoPath.startsWith(prefix)) {
      byLayerPath.set(repoPath.slice(prefix.length), lines);
    }
  }

  return byLayerPath;
}

function layerChangedLines(layer) {
  return toLayerChangedLines(
    parseChangedLines(
      run(["diff", "-U0", "--diff-filter=ACMR", pushRange(), "--", "."]),
    ),
    layer,
  );
}

export function isMutationTarget(layerPath, mutateGlobs) {
  const included = mutateGlobs.filter((glob) => !glob.startsWith("!"));
  const excluded = mutateGlobs
    .filter((glob) => glob.startsWith("!"))
    .map((glob) => glob.slice(1));

  return (
    included.some((glob) => path.matchesGlob(layerPath, glob)) &&
    !excluded.some((glob) => path.matchesGlob(layerPath, glob))
  );
}

export function specToSource(repoPath, { layer, exists = existsSync }) {
  const layerPath = repoPath.slice(layerPrefix(layer).length);
  const dir = path.posix.dirname(layerPath).replace(/\/__tests__$/, "");
  const segments = path.posix
    .basename(layerPath)
    .replace(SPEC_SUFFIX, "")
    .split(".");

  for (let count = segments.length; count >= 1; count--) {
    for (const extension of SOURCE_EXTENSIONS) {
      const candidate = path.posix.join(
        dir,
        `${segments.slice(0, count).join(".")}${extension}`,
      );
      if (exists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export function collectTargets(
  files,
  { layer, mutateGlobs, exists = existsSync },
) {
  const prefix = layerPrefix(layer);
  const directSources = new Set();
  const specSources = new Map();
  const unmapped = [];
  const skipped = [];
  const support = [];

  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const layerPath = file.slice(prefix.length);
    const isSpec = SPEC_SUFFIX.test(layerPath);

    if (!isSpec && TEST_SUPPORT.test(layerPath)) {
      support.push(layerPath);
      continue;
    }

    if (!layerPath.startsWith(`${SOURCE_ROOT}/`)) continue;

    if (E2E_SPEC.test(layerPath)) {
      skipped.push(layerPath);
      continue;
    }

    if (isSpec) {
      const source = specToSource(file, { layer, exists });
      if (!source) {
        unmapped.push(layerPath);
        continue;
      }
      if (!isMutationTarget(source, mutateGlobs)) continue;
      if (!specSources.has(source)) {
        specSources.set(source, new Set());
      }
      specSources.get(source).add(layerPath);
      continue;
    }

    if (isMutationTarget(layerPath, mutateGlobs)) {
      directSources.add(layerPath);
    }
  }

  const mutate = new Set([...directSources, ...specSources.keys()]);
  return { directSources, specSources, mutate, unmapped, skipped, support };
}

export function widenToFullScope(targets, { tracked, layer, mutateGlobs }) {
  const prefix = layerPrefix(layer);
  const sources = tracked
    .filter((file) => file.startsWith(prefix))
    .map((file) => file.slice(prefix.length))
    .filter(
      (layerPath) =>
        layerPath.startsWith(`${SOURCE_ROOT}/`) &&
        !SPEC_SUFFIX.test(layerPath) &&
        !TEST_SUPPORT.test(layerPath) &&
        isMutationTarget(layerPath, mutateGlobs),
    );

  return {
    ...targets,
    directSources: new Set(sources),
    mutate: new Set(sources),
  };
}

export function restrictTargets(targets, only) {
  if (!only) return targets;

  const slice = new Set(only.split(","));
  return {
    ...targets,
    directSources: new Set(
      [...targets.directSources].filter((file) => slice.has(file)),
    ),
    specSources: new Map(
      [...targets.specSources].filter(([file]) => slice.has(file)),
    ),
    mutate: new Set([...targets.mutate].filter((file) => slice.has(file))),
  };
}

function testIdsForSpecs(report, specKeys) {
  const ids = new Set();
  for (const key of specKeys) {
    for (const test of report.testFiles?.[key]?.tests ?? []) {
      ids.add(test.id);
    }
  }
  return ids;
}

function collectSurvivorLines(file, mutants, sourceLines, scope, result) {
  const { isDirect, scopeIds, changed, origin } = scope;
  const survivorLines = new Map();

  for (const mutant of mutants) {
    if (mutant.status !== "Survived") continue;
    const line = mutant.location?.start?.line ?? "?";

    const inScope =
      isDirect || (mutant.coveredBy ?? []).some((id) => scopeIds.has(id));
    if (!inScope) continue;

    const mutantClass = classifyMutant(mutant, sourceLines);

    if (mutantClass === MutantClass.UNMEASURED) {
      result.offenders.push(
        `${file}:${line} ${mutant.mutatorName} [unmeasured: Survived with no test run, run the push again]`,
      );
      continue;
    }

    if (mutantClass === MutantClass.LOG) {
      result.ignoredLogs.push(`${file}:${line} ${mutant.mutatorName}`);
      continue;
    }

    if (changed.has(line)) {
      result.offenders.push(
        `${file}:${line} ${mutant.mutatorName} [${origin}, line changed in the push]`,
      );
      continue;
    }

    if (!survivorLines.has(mutant.mutatorName)) {
      survivorLines.set(mutant.mutatorName, []);
    }
    survivorLines.get(mutant.mutatorName).push(line);
  }

  return survivorLines;
}

function compareWithBaseline(
  file,
  survivorLines,
  fileBaseline,
  origin,
  result,
) {
  const mutators = new Set([
    ...survivorLines.keys(),
    ...Object.keys(fileBaseline),
  ]);

  for (const mutatorName of [...mutators].toSorted()) {
    const lines = survivorLines.get(mutatorName) ?? [];
    const allowed = fileBaseline[mutatorName] ?? 0;

    if (lines.length > allowed) {
      for (const line of lines) {
        result.offenders.push(
          `${file}:${line} ${mutatorName} [${origin}, above baseline: ${lines.length} alive, baseline ${allowed}]`,
        );
      }
    } else if (lines.length < allowed) {
      result.improvements.push(
        `${file} ${mutatorName}: ${lines.length} alive, baseline ${allowed}`,
      );
    }
  }
}

export function survivorsIn(
  report,
  directSources,
  specSources,
  { baseline = {}, changedLines = new Map() } = {},
) {
  const result = {
    offenders: [],
    warnings: [],
    ignoredLogs: [],
    improvements: [],
  };
  const files = new Set([...directSources, ...specSources.keys()]);

  for (const file of files) {
    const fileReport = report.files?.[file];
    const mutants = fileReport?.mutants ?? [];
    const sourceLines = (fileReport?.source ?? "").split("\n");
    const isDirect = directSources.has(file);
    const scopeIds = isDirect
      ? null
      : testIdsForSpecs(report, specSources.get(file));

    if (!isDirect && scopeIds.size === 0) {
      result.warnings.push(
        `${file}: the changed spec's tests covered no mutant (suspicious spec→source mapping).`,
      );
    }

    const origin = isDirect ? "source in the push" : "push spec left it alive";
    const changed = isDirect
      ? (changedLines.get(file) ?? new Set())
      : new Set();
    const survivorLines = collectSurvivorLines(
      file,
      mutants,
      sourceLines,
      { isDirect, scopeIds, changed, origin },
      result,
    );

    compareWithBaseline(
      file,
      survivorLines,
      baseline[file] ?? {},
      origin,
      result,
    );
  }

  return result;
}

export function shouldForceMutation({ env, layer, files, support }) {
  return (
    env.MUTATION_FORCE === "1" || needsFullScope({ env, layer, files, support })
  );
}

export function needsFullScope({ env, layer, files, support }) {
  if (env.CI !== "true") return false;

  const prefix = layerPrefix(layer);
  return (
    support.length > 0 ||
    files.some(
      (file) =>
        file.startsWith(prefix) &&
        FULL_RUN_TRIGGER.test(file.slice(prefix.length)),
    )
  );
}

export const STRYKER_PROGRESS_BAR_MIN_COLUMNS = 135;

export function fitsProgressBar({ isTTY, columns }) {
  return isTTY === true && (columns ?? 0) >= STRYKER_PROGRESS_BAR_MIN_COLUMNS;
}

export function strykerArgs(
  mutate,
  { force = false, interactive = false } = {},
) {
  return [
    "run",
    "--mutate",
    [...mutate].join(","),
    "--reporters",
    interactive ? "json,progress" : "json,progress-append-only",
    "--logLevel",
    "warn",
    ...(force ? ["--force"] : []),
  ];
}

async function main() {
  const rootDir = run(["rev-parse", "--show-toplevel"]).trim();
  const layer = path.relative(rootDir, process.cwd());
  const strykerConfig = readJsonFile("stryker.config.json");
  const { mutate: mutateGlobs = [] } = strykerConfig;
  const files = changedFiles();
  const rangeTargets = collectTargets(files, { layer, mutateGlobs });
  const scope = {
    env: process.env,
    layer,
    files,
    support: rangeTargets.support,
  };
  const targets = needsFullScope(scope)
    ? widenToFullScope(rangeTargets, {
        tracked: run(["ls-files"]).split("\n").filter(Boolean),
        layer,
        mutateGlobs,
      })
    : rangeTargets;
  const { directSources, specSources, mutate, unmapped, skipped, support } =
    restrictTargets(targets, process.env.MUTATION_ONLY);
  const force = shouldForceMutation(scope);

  for (const specKey of unmapped) {
    console.warn(`⚠ spec without a mappable source (ignored): ${specKey}`);
  }
  for (const specKey of skipped) {
    console.warn(
      `⚠ e2e lane spec outside mutation (Stryker runs only the unit lane): ${specKey}`,
    );
  }
  for (const file of support) {
    console.warn(
      `⚠ test support changed (Stryker's incremental cannot see it; the full mutation runs in CI): ${file}`,
    );
  }

  if (mutate.size === 0) {
    console.log(
      `No source under ${SOURCE_ROOT}/ (direct or via spec) in this push — mutation skipped.`,
    );
    return;
  }

  if (process.env.MUTATION_DRY_RUN === "1") {
    console.log("[dry-run] mutate:", [...mutate].join(", "));
    console.log(
      "[dry-run] source in the push:",
      [...directSources].join(", ") || "(none)",
    );
    for (const [source, specs] of specSources) {
      console.log(`[dry-run] via spec: ${source} ← ${[...specs].join(", ")}`);
    }
    console.log(`[dry-run] --force: ${force ? "yes" : "no"}`);
    return;
  }

  if (force) {
    console.log(
      "Mutation with --force, reusing no previous result (MUTATION_FORCE=1, or CI with test support, dependency or config in the range).",
    );
  }

  const status = await runStryker(
    strykerArgs(mutate, {
      force,
      interactive: fitsProgressBar(process.stdout),
    }),
  );
  if (status !== 0) {
    console.error("Stryker failed — push aborted.");
    process.exitCode = status;
    return;
  }

  let report;
  try {
    report = readJsonFile("reports/mutation/report.json");
  } catch {
    console.error("Stryker JSON report not found — push aborted for safety.");
    process.exitCode = 1;
    return;
  }

  const remeasure = await remeasureHybridSurvivors(report, {
    baseConfig: strykerConfig,
    runStryker,
    readJson: readJsonFile,
    writeJson: writeJsonFile,
  });
  if (remeasure.status !== 0) {
    console.error(
      "Stryker failed while measuring the surviving static mutants — push aborted.",
    );
    process.exitCode = remeasure.status;
    return;
  }
  if (remeasure.remeasured > 0) {
    console.log(
      `${remeasure.remeasured} surviving static mutant(s) measured again with all tests (ignoreStatic: false).`,
    );
    report = remeasure.report;
    writeJsonFile("reports/mutation/report.json", report);
  }

  const { offenders, warnings, improvements } = survivorsIn(
    report,
    directSources,
    specSources,
    {
      baseline: readBaseline(BASELINE_FILE),
      changedLines: layerChangedLines(layer),
    },
  );

  for (const warning of warnings) {
    console.warn(`⚠ ${warning}`);
  }

  if (improvements.length > 0) {
    console.log(
      "↓ Fewer survivors than the baseline (run npm run test:mutation:baseline and commit mutation-baseline.json):",
    );
    for (const improvement of improvements) {
      console.log(`  ${improvement}`);
    }
  }

  if (offenders.length > 0) {
    console.error(
      `\n✗ ${offenders.length} SURVIVING mutant(s) in file(s) of this push:`,
    );
    for (const offender of offenders) {
      console.error(`  ${offender}`);
    }
    console.error(
      "\nStrengthen the test: a survivor on a line changed in the push never passes, and the rest of the file cannot exceed mutation-baseline.json. Push aborted.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    "✓ No survivor on the changed lines and no file above the baseline.",
  );
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  await main();
}
