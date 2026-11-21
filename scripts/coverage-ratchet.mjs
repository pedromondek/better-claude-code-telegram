import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CONFIG = "vitest.config.ts";
const OPTION_KEYS = new Set([
  "lines",
  "functions",
  "branches",
  "statements",
  "perFile",
  "autoUpdate",
  "100",
]);

export function globThresholdKeys(thresholds) {
  return Object.keys(thresholds ?? {}).filter((key) => !OPTION_KEYS.has(key));
}

export function unmatchedGlobs(globs, files) {
  return globs.filter(
    (glob) => !files.some((file) => path.matchesGlob(file, glob)),
  );
}

export function ratchetArgsError(args) {
  if (args.length === 0) return null;

  return `The ratchet runs the whole suite and takes no argument (got: ${args.join(" ")}).`;
}

function npm(...args) {
  return spawnSync("npm", ["run", "--silent", ...args], {
    stdio: "inherit",
    env: { ...process.env, COVERAGE_RATCHET: "1" },
  });
}

async function main() {
  const argsError = ratchetArgsError(process.argv.slice(2));

  if (argsError) {
    console.error(argsError);
    process.exitCode = 1;
    return;
  }

  const run = npm("test:cov");

  if (run.status !== 0) {
    console.error("✗ The suite or the floor failed: ratchet stopped.");
    process.exitCode = run.status ?? 1;
    return;
  }

  const summary = JSON.parse(
    readFileSync(path.join("coverage", "coverage-summary.json"), "utf8"),
  );
  const files = Object.keys(summary)
    .filter((key) => key !== "total")
    .map((file) => path.relative(process.cwd(), file));
  const { default: config } = await import(
    pathToFileURL(path.resolve(CONFIG)).href
  );
  const missing = unmatchedGlobs(
    globThresholdKeys(config.test?.coverage?.thresholds),
    files,
  );

  if (missing.length > 0) {
    console.error(
      `✗ Threshold glob that matches no file (typo or renamed folder): ${missing.join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  npm("format:file", "--", CONFIG);
  spawnSync("git", ["diff", "--", CONFIG], { stdio: "inherit" });
  console.log(
    `✓ Ratchet done. If the floor moved, ${CONFIG} goes in the same commit as the test that paid the debt.`,
  );
}

if (import.meta.main) {
  await main();
}
