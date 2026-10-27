import { readFileSync } from "node:fs";
import path from "node:path";

import { git } from "./git.mjs";
import { collectTargets } from "./mutation-prepush.mjs";
import { formatScore, scoreFile } from "./mutation-report.mjs";
import { runStryker } from "./stryker-run.mjs";

function run(args) {
  try {
    return git(args);
  } catch {
    return "";
  }
}

function changedFiles() {
  const raw = `${run(["diff", "--name-only", "--diff-filter=ACMR", "HEAD"])}\n${run(["diff", "--name-only", "--diff-filter=ACMR", "--cached"])}`;

  return [...new Set(raw.split("\n").map((file) => file.trim()))].filter(
    Boolean,
  );
}

async function main() {
  const rootDir = run(["rev-parse", "--show-toplevel"]).trim();
  const layer = path.relative(rootDir, process.cwd());
  const { mutate: mutateGlobs = [] } = JSON.parse(
    readFileSync("stryker.config.json", "utf8"),
  );
  const files = [
    ...collectTargets(changedFiles(), { layer, mutateGlobs }).directSources,
  ];

  if (files.length === 0) {
    console.log(
      "No source under plugins/telegram/extensions/ changed (working tree vs HEAD) — nothing to mutate.",
    );
    return;
  }

  console.log(
    `Mutating ${files.length} changed file(s):\n${files.map((file) => `  ${file}`).join("\n")}`,
  );

  const status = await runStryker([
    "run",
    "--mutate",
    files.join(","),
    "--reporters",
    "json",
  ]);
  if (status !== 0) {
    process.exitCode = status;
    return;
  }

  let report;
  try {
    report = JSON.parse(readFileSync("reports/mutation/report.json", "utf8"));
  } catch {
    console.error("Stryker JSON report not found — see reports/mutation/.");
    process.exitCode = 1;
    return;
  }

  for (const file of files) {
    console.log("");
    for (const line of formatScore(file, scoreFile(report, file))) {
      console.log(line);
    }
  }
}

await main();
