import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { git } from "./git.mjs";
import { pushRange } from "./push-range.mjs";
import {
  cargoMutantsArgs,
  rustDiff,
  touchesRustSource,
} from "./rust-mutation-prepush.mjs";

export const MUTANTS_PER_SHARD = 18;
export const MAX_SHARDS = 20;

const PLAN_DIR = "rust-mutation-plan";
const OUTCOMES_DIR = "rust/mutants.out";
const CAUGHT_FILES = ["caught.txt", "previously_caught.txt"];
const UNVIABLE_FILE = "unviable.txt";
const PREVIOUSLY_CAUGHT_FILE = "previously_caught.txt";
const SHARD = /^(\d+)\/(\d+)$/u;
const FULL_SCOPE = [
  /^rust\/Cargo\.(toml|lock)$/u,
  /^rust\/crates\/[^/]+\/Cargo\.toml$/u,
  /^rust-toolchain\.toml$/u,
  /^rust\/\.cargo\//u,
  /^rust\/crates\/[^/]+\/tests\//u,
];

export function shardCount(mutants) {
  return Math.min(MAX_SHARDS, Math.ceil(mutants / MUTANTS_PER_SHARD));
}

export function needsFullRustScope(files) {
  return files.some((file) => FULL_SCOPE.some((rule) => rule.test(file)));
}

function linesOf(file) {
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

function writeLines(file, lines) {
  writeFileSync(file, lines.length > 0 ? `${lines.join("\n")}\n` : "");
}

export function mergeOutcomes(folders, into) {
  const caught = new Set();
  const unviable = new Set();

  for (const folder of folders) {
    for (const name of CAUGHT_FILES) {
      for (const line of linesOf(join(folder, name))) caught.add(line);
    }
    for (const line of linesOf(join(folder, UNVIABLE_FILE))) unviable.add(line);
  }

  mkdirSync(into, { recursive: true });
  writeLines(join(into, PREVIOUSLY_CAUGHT_FILE), [...caught].toSorted());
  writeLines(join(into, UNVIABLE_FILE), [...unviable].toSorted());
}

function writeOutputs(values) {
  const file = process.env.GITHUB_OUTPUT;
  const text = Object.entries(values)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");

  if (file) {
    appendFileSync(file, text);
  } else {
    process.stdout.write(text);
  }
}

function changedFiles(range) {
  return git(["diff", "--name-only", range])
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
}

function plan() {
  const range = pushRange();
  const diff = rustDiff(range);

  rmSync(PLAN_DIR, { recursive: true, force: true });

  if (!touchesRustSource(diff)) {
    console.log("✓ rust mutation skipped: no Rust source in the range");
    writeOutputs({ count: 0, shards: "[]", iterate: false });
    return 0;
  }

  const iterate =
    process.env.RUST_MUTATION_FULL !== "true" &&
    !needsFullRustScope(changedFiles(range));
  const diffFile = resolve(PLAN_DIR, "push.diff");

  mkdirSync(PLAN_DIR, { recursive: true });
  writeFileSync(diffFile, diff);
  writeFileSync(join(PLAN_DIR, "iterate"), `${iterate}\n`);

  if (iterate) {
    mergeOutcomes([OUTCOMES_DIR], join(PLAN_DIR, "outcomes"));
  } else {
    rmSync(OUTCOMES_DIR, { recursive: true, force: true });
  }

  const result = spawnSync(
    "sh",
    cargoMutantsArgs(diffFile, ["--list", ...(iterate ? ["--iterate"] : [])]),
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );

  if (result.error || result.status !== 0) {
    console.error(
      `✗ rust mutation could not list the mutants: ${result.error?.message ?? `exit ${result.status}`}`,
    );
    return 1;
  }

  const count = result.stdout.split("\n").filter(Boolean).length;
  const shards = Array.from({ length: shardCount(count) }, (_, index) => index);

  console.log(
    `✓ ${count} mutants to test in ${shards.length} shards${iterate ? ", skipping the ones already caught" : ", from scratch"}`,
  );
  writeOutputs({ count, shards: JSON.stringify(shards), iterate });
  return 0;
}

function shard() {
  const match = SHARD.exec(process.env.RUST_MUTATION_SHARD ?? "");

  if (!match || Number(match[1]) >= Number(match[2])) {
    console.error(
      "✗ RUST_MUTATION_SHARD must be k/n with k below n, counting from 0",
    );
    return 1;
  }

  const iterate =
    readFileSync(join(PLAN_DIR, "iterate"), "utf8").trim() === "true";

  rmSync(OUTCOMES_DIR, { recursive: true, force: true });
  if (iterate) mergeOutcomes([join(PLAN_DIR, "outcomes")], OUTCOMES_DIR);

  const result = spawnSync(
    "sh",
    cargoMutantsArgs(resolve(PLAN_DIR, "push.diff"), [
      ...(iterate ? ["--iterate"] : []),
      "--shard",
      match[0],
      "--sharding",
      "round-robin",
    ]),
    { stdio: "inherit" },
  );

  if (result.error) {
    console.error(`✗ rust mutation could not start: ${result.error.message}`);
    return 1;
  }

  return result.status ?? 1;
}

function merge(folders) {
  mergeOutcomes(folders, OUTCOMES_DIR);
  return 0;
}

const MODES = { plan, shard, merge };

function main([mode, ...rest]) {
  const run = MODES[mode];

  if (!run) {
    console.error("✗ the mode must be plan, shard or merge");
    return 1;
  }

  return run(rest);
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  process.exitCode = main(process.argv.slice(2));
}
