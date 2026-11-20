import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  mergeOutcomes,
  MUTANTS_PER_SHARD,
  MAX_SHARDS,
  needsFullRustScope,
  shardCount,
} from "../rust-mutation-ci.mjs";

const SCRIPT = join(import.meta.dirname, "..", "rust-mutation-ci.mjs");
const SOURCE = "rust/crates/bcct/src/hook.rs";

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

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fakeSh() {
  const file = join(bin, "sh");
  writeFileSync(
    file,
    [
      "#!/bin/bash",
      'printf "%s\\n" "$@" > "$FAKE_SH_ARGS"',
      'ls rust/mutants.out > "$FAKE_SH_OUTCOMES" 2>/dev/null',
      'for arg in "$@"; do [ "$arg" = "--list" ] && printf "%s" "$FAKE_SH_LIST" && exit 0; done',
      "echo FAKE_SH_STDOUT",
      "exit ${FAKE_SH_EXIT:-0}",
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: scratch,
      GITHUB_OUTPUT: join(scratch, "output.txt"),
      FAKE_SH_ARGS: join(bin, "args.txt"),
      FAKE_SH_OUTCOMES: join(bin, "outcomes.txt"),
      ...env,
    },
  });
}

function recordedArgs() {
  return readFileSync(join(bin, "args.txt"), "utf8").trim().split("\n");
}

function outputs() {
  const file = join(scratch, "output.txt");

  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function lines(path) {
  return readFileSync(path, "utf8").trim().split("\n");
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "rust-mutation-ci-repo-"));
  bin = mkdtempSync(join(tmpdir(), "rust-mutation-ci-bin-"));
  scratch = mkdtempSync(join(tmpdir(), "rust-mutation-ci-scratch-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "probe@example.test");
  git("config", "user.name", "probe");
  commitFile(SOURCE, "fn a() {}\n");
  fakeSh();
});

afterEach(() => {
  for (const folder of [repo, bin, scratch]) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe("shardCount", () => {
  it("gives no shard without mutants and caps the shards at the concurrent job limit", () => {
    expect(shardCount(0)).toBe(0);
    expect(shardCount(1)).toBe(1);
    expect(shardCount(MUTANTS_PER_SHARD)).toBe(1);
    expect(shardCount(MUTANTS_PER_SHARD + 1)).toBe(2);
    expect(shardCount(364)).toBe(MAX_SHARDS);
    expect(shardCount(3391)).toBe(MAX_SHARDS);
  });
});

describe("needsFullRustScope", () => {
  it("drops the previous outcomes when the range touches a dependency, the mutation config or a test", () => {
    for (const file of [
      "rust/Cargo.lock",
      "rust/Cargo.toml",
      "rust/crates/bcct/Cargo.toml",
      "rust-toolchain.toml",
      "rust/.cargo/mutants.toml",
      "rust/crates/bcct/tests/support/mod.rs",
      "rust/crates/bcct/tests/fixtures/hook.json",
      "rust/crates/bcct/tests/hook_process.rs",
    ]) {
      expect({ file, full: needsFullRustScope([file]) }).toEqual({
        file,
        full: true,
      });
    }
  });

  it("keeps the previous outcomes when only sources and other folders change", () => {
    expect(needsFullRustScope([SOURCE, "scripts/git.mjs", "README.md"])).toBe(
      false,
    );
  });
});

describe("mergeOutcomes", () => {
  it("joins the caught and unviable mutants of every folder, once each and sorted", () => {
    const first = join(scratch, "first");
    const second = join(scratch, "second");
    const into = join(scratch, "into");
    writeFile(join(first, "caught.txt"), "b\na\n");
    writeFile(join(first, "unviable.txt"), "u\n");
    writeFile(join(second, "previously_caught.txt"), "a\nc\n");
    writeFile(join(second, "missed.txt"), "m\n");

    mergeOutcomes([first, second, join(scratch, "absent")], into);

    expect(lines(join(into, "previously_caught.txt"))).toEqual(["a", "b", "c"]);
    expect(lines(join(into, "unviable.txt"))).toEqual(["u"]);
    expect(existsSync(join(into, "missed.txt"))).toBe(false);
  });
});

describe("scripts/rust-mutation-ci.mjs plan", () => {
  it("plans no shard and calls no cargo-mutants when the range has no Rust source", () => {
    commitFile("README.md", "x\n");

    const result = run(["plan"], { MUTATION_RANGE: "HEAD~1..HEAD" });

    expect(result.status).toBe(0);
    expect(outputs()).toContain("count=0\n");
    expect(outputs()).toContain("shards=[]\n");
    expect(existsSync(join(bin, "args.txt"))).toBe(false);
  });

  it("lists the mutants of the diff with the previous outcomes and plans the shards", () => {
    commitFile(SOURCE, "fn a() { b() }\n");
    writeFile(join(repo, "rust", "mutants.out", "caught.txt"), "old\n");

    const result = run(["plan"], {
      MUTATION_RANGE: "HEAD~1..HEAD",
      FAKE_SH_LIST: "one\ntwo\nthree\n",
    });

    expect(result.status).toBe(0);
    expect(recordedArgs()).toEqual(
      expect.arrayContaining(["--list", "--iterate", "--in-diff"]),
    );
    expect(outputs()).toContain("count=3\n");
    expect(outputs()).toContain("shards=[0]\n");
    expect(outputs()).toContain("iterate=true\n");
    expect(
      lines(
        join(repo, "rust-mutation-plan", "outcomes", "previously_caught.txt"),
      ),
    ).toEqual(["old"]);
    expect(
      readFileSync(join(repo, "rust-mutation-plan", "push.diff"), "utf8"),
    ).toContain("+fn a() { b() }");
  });

  it("drops the previous outcomes when asked for the full run or when the range touches the lock", () => {
    writeFile(join(repo, "rust", "mutants.out", "caught.txt"), "old\n");
    commitFile(SOURCE, "fn a() { b() }\n");

    const full = run(["plan"], {
      MUTATION_RANGE: "HEAD~1..HEAD",
      RUST_MUTATION_FULL: "true",
      FAKE_SH_LIST: "one\n",
    });

    expect(full.status).toBe(0);
    expect(recordedArgs()).not.toContain("--iterate");
    expect(outputs()).toContain("iterate=false\n");
    expect(
      existsSync(
        join(repo, "rust-mutation-plan", "outcomes", "previously_caught.txt"),
      ),
    ).toBe(false);

    commitFile("rust/Cargo.lock", "lock\n");
    commitFile(SOURCE, "fn a() { c() }\n");
    rmSync(join(scratch, "output.txt"), { force: true });

    const lock = run(["plan"], {
      MUTATION_RANGE: "HEAD~2..HEAD",
      FAKE_SH_LIST: "one\n",
    });

    expect(lock.status).toBe(0);
    expect(recordedArgs()).not.toContain("--iterate");
    expect(outputs()).toContain("iterate=false\n");
  });
});

describe("scripts/rust-mutation-ci.mjs shard", () => {
  function plan(iterate) {
    const folder = join(repo, "rust-mutation-plan");
    writeFile(join(folder, "push.diff"), "diff\n");
    writeFile(join(folder, "iterate"), iterate ? "true\n" : "false\n");
    writeFile(join(folder, "outcomes", "previously_caught.txt"), "old\n");
  }

  it("runs its shard of the planned diff in place, round-robin, with the planned outcomes", () => {
    plan(true);

    const result = run(["shard"], { RUST_MUTATION_SHARD: "2/3" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("FAKE_SH_STDOUT");
    expect(recordedArgs()).toEqual(
      expect.arrayContaining([
        "--in-place",
        "--in-diff",
        "--iterate",
        "--shard",
        "2/3",
        "--sharding",
        "round-robin",
        "--test-tool=nextest",
      ]),
    );
    expect(readFileSync(join(bin, "outcomes.txt"), "utf8")).toContain(
      "previously_caught.txt",
    );
  });

  it("runs without the previous outcomes when the plan dropped them", () => {
    plan(false);

    run(["shard"], { RUST_MUTATION_SHARD: "0/1" });

    expect(recordedArgs()).not.toContain("--iterate");
  });

  it("hands back the exit code of cargo-mutants, so a missed mutant fails the job", () => {
    plan(true);

    const result = run(["shard"], {
      RUST_MUTATION_SHARD: "1/2",
      FAKE_SH_EXIT: "2",
    });

    expect(result.status).toBe(2);
  });

  it("refuses a shard that is not k/n with k below n, as cargo-mutants counts from 0", () => {
    plan(true);

    for (const shard of ["two", "3/3", "1/0"]) {
      const result = run(["shard"], { RUST_MUTATION_SHARD: shard });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("RUST_MUTATION_SHARD");
    }
    expect(existsSync(join(bin, "args.txt"))).toBe(false);
  });
});

describe("scripts/rust-mutation-ci.mjs merge", () => {
  it("merges the plan and every shard output into rust/mutants.out for the cache", () => {
    writeFile(
      join(repo, "rust-mutation-plan", "outcomes", "previously_caught.txt"),
      "old\n",
    );
    writeFile(join(repo, "shards", "1", "caught.txt"), "new\n");

    const result = run(["merge", "rust-mutation-plan/outcomes", "shards/1"]);

    expect(result.status).toBe(0);
    expect(
      lines(join(repo, "rust", "mutants.out", "previously_caught.txt")),
    ).toEqual(["new", "old"]);
  });
});

describe("scripts/rust-mutation-ci.mjs", () => {
  it("refuses an unknown mode", () => {
    const result = run(["other"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("plan, shard or merge");
  });
});
