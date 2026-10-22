import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { git } from "./git.mjs";
import { pushRange } from "./push-range.mjs";

const HUNK = /^@@ -\d+(?:,\d+)? \+(?<start>\d+)(?:,(?<count>\d+))? @@/u;
const TEST_FILE = /(?:^|\/)__tests__\/|\.(?:spec|test)\.[cm]?[jt]sx?$/u;
const DESTINATION = "+++ b/";

export function parseChangedLines(diffText) {
  const changed = new Map();
  let current;
  let inHeader = false;

  for (const line of diffText.split("\n")) {
    const hunk = HUNK.exec(line);

    if (line.startsWith("diff --git ")) {
      inHeader = true;
      current = undefined;
    } else if (inHeader && line.startsWith(DESTINATION)) {
      current = line.slice(DESTINATION.length);
    } else if (hunk !== null) {
      inHeader = false;

      const start = Number(hunk.groups.start);
      const count =
        hunk.groups.count === undefined ? 1 : Number(hunk.groups.count);

      if (current === undefined || count === 0) continue;
      if (!changed.has(current)) changed.set(current, new Set());

      for (let offset = 0; offset < count; offset += 1) {
        changed.get(current).add(start + offset);
      }
    }
  }

  return changed;
}

export function isCoverageTarget(file, coverage) {
  if (TEST_FILE.test(file)) return false;

  return (
    coverage.include.some((glob) => path.matchesGlob(file, glob)) &&
    !coverage.exclude.some((glob) => path.matchesGlob(file, glob))
  );
}

function executedLines(fileCoverage) {
  const lines = new Map();

  for (const [id, location] of Object.entries(fileCoverage.statementMap)) {
    const line = location.start.line;
    const count = fileCoverage.s[id] ?? 0;
    lines.set(line, Math.max(lines.get(line) ?? 0, count));
  }

  return lines;
}

export function uncoveredChangedLines(
  changed,
  coverageByFile,
  { rootDir, coverage },
) {
  const uncovered = [];
  const missing = [];

  for (const [file, lines] of changed) {
    if (!isCoverageTarget(file, coverage)) continue;

    const fileCoverage = coverageByFile[path.resolve(rootDir, file)];

    if (!fileCoverage) {
      missing.push(file);
      continue;
    }

    const executed = executedLines(fileCoverage);

    for (const line of [...lines].toSorted((a, b) => a - b)) {
      if (executed.get(line) === 0) uncovered.push({ file, line });
    }
  }

  return { uncovered, missing };
}

async function main() {
  const rootDir = git(["rev-parse", "--show-toplevel"]).trim();
  const range = process.env.COVERAGE_RANGE ?? pushRange();
  const diff = git([
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--unified=0",
    "--diff-filter=ACMR",
    range,
  ]);

  let coverageByFile;

  try {
    coverageByFile = JSON.parse(
      readFileSync(
        path.join(rootDir, "coverage", "coverage-final.json"),
        "utf8",
      ),
    );
  } catch {
    console.error(
      "✗ coverage/coverage-final.json not found: run npm run test:cov first. Push stopped to be safe.",
    );
    process.exitCode = 1;
    return;
  }

  const { default: config } = await import(
    pathToFileURL(path.join(rootDir, "vitest.config.ts")).href
  );
  const { include = [], exclude = [] } = config.test?.coverage ?? {};
  const { uncovered, missing } = uncoveredChangedLines(
    parseChangedLines(diff),
    coverageByFile,
    { rootDir, coverage: { include, exclude } },
  );

  for (const file of missing) {
    console.error(`✗ ${file}: no coverage data (outside the include?).`);
  }

  if (uncovered.length > 0) {
    console.error(`\n✗ ${uncovered.length} changed line(s) that no test runs:`);

    for (const { file, line } of uncovered) {
      console.error(`  ${file}:${line}`);
    }
  }

  if (uncovered.length > 0 || missing.length > 0) {
    console.error("\nCover the changed lines. Push stopped.");
    process.exitCode = 1;
    return;
  }

  console.log("✓ Every executable line changed in this push runs in a test.");
}

if (import.meta.main) {
  await main();
}
