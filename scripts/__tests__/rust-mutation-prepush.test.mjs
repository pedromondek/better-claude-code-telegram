import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { touchesRustSource } from "../rust-mutation-prepush.mjs";

const SCRIPT = join(import.meta.dirname, "..", "rust-mutation-prepush.mjs");

let repo;
let bin;
let scratch;

function git(...args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });

  if (result.status !== 0) throw new Error(result.stderr);

  return result.stdout.trim();
}

function commitFile(file, content) {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), content);
  git("add", file);
  git("commit", "-qm", file);
}

function fakeSh() {
  const file = join(bin, "sh");
  writeFileSync(
    file,
    [
      "#!/bin/bash",
      'printf "%s\\n" "$@" > "$FAKE_SH_ARGS"',
      'cp "${@: -1}" "$FAKE_SH_DIFF" 2>/dev/null',
      'echo "TMP_FILE=${@: -1}" >> "$FAKE_SH_ARGS"',
      "echo FAKE_SH_STDOUT",
      "exit ${FAKE_SH_EXIT:-0}",
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
}

function run(range, env = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: scratch,
      MUTATION_RANGE: range,
      FAKE_SH_ARGS: join(bin, "args.txt"),
      FAKE_SH_DIFF: join(bin, "diff.txt"),
      ...env,
    },
  });
}

function recordedArgs() {
  return readFileSync(join(bin, "args.txt"), "utf8").trim().split("\n");
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "bcct-rust-mutation-"));
  bin = mkdtempSync(join(tmpdir(), "bcct-rust-mutation-bin-"));
  scratch = mkdtempSync(join(tmpdir(), "bcct-rust-mutation-tmp-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  commitFile("README.md", "base\n");
  fakeSh();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe("touchesRustSource", () => {
  it.each([
    "--- a/crates/bcct/src/lib.rs\n+++ b/crates/bcct/src/lib.rs\n",
    "--- /dev/null\n+++ b/crates/bcct/src/new.rs\n",
    "--- a/crates/bcct/src/old.rs\n+++ /dev/null\n",
  ])("is true when the diff, relative to rust/, touches a .rs file", (diff) => {
    expect(touchesRustSource(diff)).toBe(true);
  });

  it.each([
    "",
    "--- a/Cargo.toml\n+++ b/Cargo.toml\n",
    "--- a/crates/bcct/src/lib.rs.bak\n+++ b/crates/bcct/src/lib.rs.bak\n",
  ])("is false when no .rs file is touched", (diff) => {
    expect(touchesRustSource(diff)).toBe(false);
  });
});

describe("scripts/rust-mutation-prepush.mjs", () => {
  it("skips and exits 0 without calling cargo-mutants when the push has no Rust source", () => {
    const base = git("rev-parse", "HEAD");
    commitFile("rust/Cargo.toml", "[workspace]\n");
    commitFile("docs/a.md", "a\n");

    const result = run(`${base}...HEAD`);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "✓ rust mutation skipped: no Rust source in the push",
    );
    expect(existsSync(join(bin, "args.txt"))).toBe(false);
  });

  it("runs cargo-mutants in place on the diff of the push and hands back its stdout", () => {
    const base = git("rev-parse", "HEAD");
    commitFile("rust/crates/bcct/src/lib.rs", "pub fn a() {}\n");

    const result = run(`${base}...HEAD`);
    const args = recordedArgs();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("FAKE_SH_STDOUT");
    expect(args.slice(0, 8)).toEqual([
      "scripts/mise-exec.sh",
      "cargo",
      "mutants",
      "--manifest-path",
      "rust/Cargo.toml",
      "--in-place",
      "--in-diff",
      args[7],
    ]);
    expect(args[7]).toMatch(/rust-mutation-diff/u);
  });

  it("gives cargo-mutants the unified=0 diff of rust/ only, with paths relative to rust/ as cargo-mutants matches them", () => {
    const base = git("rev-parse", "HEAD");
    commitFile("rust/crates/bcct/src/lib.rs", "pub fn a() {}\n");
    commitFile("docs/a.md", "a\n");
    commitFile("src/lib.rs", "pub fn b() {}\n");

    run(`${base}...HEAD`);
    const diff = readFileSync(join(bin, "diff.txt"), "utf8");

    expect(diff).toContain("+++ b/crates/bcct/src/lib.rs");
    expect(diff).not.toContain("rust/crates");
    expect(diff).toContain("@@ -0,0 +1 @@");
    expect(diff).not.toContain("docs/a.md");
    expect(diff).not.toContain("src/lib.rs\n+++ b/src/lib.rs");
    expect(diff).not.toContain("pub fn b");
  });

  it("skips when only a .rs file outside rust/ changed", () => {
    const base = git("rev-parse", "HEAD");
    commitFile("src/lib.rs", "pub fn b() {}\n");

    const result = run(`${base}...HEAD`);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "✓ rust mutation skipped: no Rust source in the push",
    );
  });

  it.each([1, 3])(
    "exits with the code %i of cargo-mutants, which blocks the push",
    (code) => {
      const base = git("rev-parse", "HEAD");
      commitFile("rust/crates/bcct/src/lib.rs", "pub fn a() {}\n");

      const result = run(`${base}...HEAD`, { FAKE_SH_EXIT: String(code) });

      expect(result.status).toBe(code);
    },
  );

  it("removes the temporary diff file after a pass and after a failure", () => {
    const base = git("rev-parse", "HEAD");
    commitFile("rust/crates/bcct/src/lib.rs", "pub fn a() {}\n");

    run(`${base}...HEAD`);
    run(`${base}...HEAD`, { FAKE_SH_EXIT: "2" });

    expect(readdirSync(scratch)).toEqual([]);
  });

  it("removes the temporary diff file when the push has no Rust source", () => {
    const base = git("rev-parse", "HEAD");
    commitFile("docs/a.md", "a\n");

    run(`${base}...HEAD`);

    expect(readdirSync(scratch)).toEqual([]);
  });

  it("fails when cargo-mutants cannot be started", () => {
    const base = git("rev-parse", "HEAD");
    commitFile("rust/crates/bcct/src/lib.rs", "pub fn a() {}\n");

    const result = run(`${base}...HEAD`, { PATH: "/nonexistent" });

    expect(result.status).not.toBe(0);
  });
});
