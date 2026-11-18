import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { git } from "./git.mjs";
import { pushRange } from "./push-range.mjs";

const RUST_SOURCE = /^(?:---|\+\+\+) [ab]\/.+\.rs$/mu;

export const RUST_MUTATION_TEST_ARGS = [
  "--test-tool=nextest",
  "--cargo-test-arg=--max-fail=1:immediate",
];

export function touchesRustSource(diff) {
  return RUST_SOURCE.test(diff);
}

function main() {
  const diff = git([
    "diff",
    "--unified=0",
    "--relative=rust",
    pushRange(),
    "--",
    "rust/",
  ]);

  if (!touchesRustSource(diff)) {
    console.log("✓ rust mutation skipped: no Rust source in the push");
    return 0;
  }

  const folder = mkdtempSync(join(tmpdir(), "rust-mutation-diff-"));

  try {
    const file = join(folder, "push.diff");
    writeFileSync(file, diff);

    const result = spawnSync(
      "sh",
      [
        "scripts/mise-exec.sh",
        "cargo",
        "mutants",
        "--manifest-path",
        "rust/Cargo.toml",
        "--in-place",
        "--in-diff",
        file,
        ...RUST_MUTATION_TEST_ARGS,
      ],
      { stdio: "inherit" },
    );

    if (result.error) {
      console.error(`✗ rust mutation could not start: ${result.error.message}`);
      return 1;
    }

    return result.status ?? 1;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  process.exitCode = main();
}
