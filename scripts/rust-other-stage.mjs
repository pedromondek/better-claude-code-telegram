import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { git } from "./git.mjs";

export const RUST_FOLDER = "rust/";

export function touchesRust(files) {
  return files === null || files.some((file) => file.startsWith(RUST_FOLDER));
}

export function changedFilesSince(before, root = ".") {
  try {
    return git([
      "-C",
      root,
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      before,
      "HEAD",
    ])
      .split("\0")
      .filter(Boolean);
  } catch {
    return null;
  }
}

export function run({ before, changedFiles, output, log }) {
  const files = before ? changedFiles(before) : null;

  if (touchesRust(files)) {
    output("run=true");
    log(
      files === null
        ? "The range is unknown: the Rust tests run on the other stage of the version."
        : "The range changes rust/: the Rust tests run on the other stage of the version.",
    );

    return 0;
  }

  output("run=false");
  log(
    "Nothing in the range changes rust/: the Rust tests on the other stage are skipped.",
  );

  return 0;
}

const entryPoint = process.argv[1];

if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  const { BEFORE, GITHUB_OUTPUT } = process.env;

  process.exitCode = run({
    before: BEFORE,
    changedFiles: changedFilesSince,
    output: (line) => appendFileSync(GITHUB_OUTPUT, `${line}\n`),
    log: (line) => console.log(line),
  });
}
