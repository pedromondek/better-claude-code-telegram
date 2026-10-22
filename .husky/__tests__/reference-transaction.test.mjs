import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HUSKY_HOOK_ARGS } from "./support/husky-hook.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const REFERENCE_TRANSACTION = join(ROOT, ".husky", "reference-transaction");
const ZERO_OID = "0".repeat(40);
const BAD_BRANCH_MESSAGE = "outside the pattern 0042-short-title";

let repo;

function gitResult(...args) {
  return spawnSync("git", args, { cwd: repo, encoding: "utf8" });
}

function git(...args) {
  const result = gitResult(...args);

  if (result.status !== 0) throw new Error(result.stderr);

  return result.stdout.trim();
}

function runHook(args, input) {
  return spawnSync("sh", [...HUSKY_HOOK_ARGS, REFERENCE_TRANSACTION, ...args], {
    cwd: repo,
    encoding: "utf8",
    input,
  });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "bcct-reference-transaction-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(join(repo, "README.md"), "base\n");
  git("add", "README.md");
  git("commit", "-qm", "base");

  const hooks = join(repo, ".hooks");
  mkdirSync(hooks);
  writeFileSync(
    join(hooks, "reference-transaction"),
    `#!/bin/sh\nexec sh ${HUSKY_HOOK_ARGS.join(" ")} "${REFERENCE_TRANSACTION}" "$@"\n`,
  );
  chmodSync(join(hooks, "reference-transaction"), 0o755);
  git("config", "core.hooksPath", hooks);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe(".husky/reference-transaction: a local branch is born in the <key>-<title> pattern", () => {
  it.each([
    ["branch", "my-branch"],
    ["checkout", "-qb", "my-branch"],
    ["switch", "-qc", "my-branch"],
  ])("refuses git %s outside the pattern", (...args) => {
    const result = gitResult(...args);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(BAD_BRANCH_MESSAGE);
    expect(git("branch", "--list", "my-branch")).toBe("");
  });

  it("accepts the branch in the pattern and the main, revert/* and dependabot/* exceptions", () => {
    git("checkout", "-q", "--detach");
    git("branch", "-D", "main");

    for (const name of [
      "0043-topics",
      "main",
      "revert/abc1234",
      "dependabot/npm_and_yarn/x-1.0.0",
    ]) {
      git("branch", name);
    }

    expect(git("branch", "--list", "0043-topics")).toContain("0043-topics");
  });

  it("stays out of commit, tag, renaming to the pattern and deleting an old branch", () => {
    git("checkout", "-qb", "0043-topics");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git("add", "a.txt");
    git("commit", "-qm", "a");
    git("tag", "v-tag");
    git("branch", "-m", "0043-topics", "0043-other-name");
    git("checkout", "-q", "main");
    git("branch", "-D", "0043-other-name");

    expect(git("log", "--format=%s", "-1", "v-tag")).toBe("a");
  });

  it.each(["preparing", "committed", "aborted"])(
    "checks nothing outside the prepared state (%s)",
    (state) => {
      const result = runHook(
        [state],
        `${ZERO_OID} ${"1".repeat(40)} refs/heads/off-pattern\n`,
      );

      expect(result.status).toBe(0);
    },
  );

  it("checks only the creation of refs/heads: update, deletion and other refs go through", () => {
    const oid = "1".repeat(40);
    const result = runHook(
      ["prepared"],
      [
        `${oid} ${"2".repeat(40)} refs/heads/off-pattern`,
        `${oid} ${ZERO_OID} refs/heads/off-pattern`,
        `${ZERO_OID} ${oid} refs/remotes/origin/off-pattern`,
        `${ZERO_OID} ${oid} refs/tags/off-pattern`,
        `${ZERO_OID} ${oid} refs/stash`,
        "ref:refs/heads/main ref:refs/heads/0043-topics HEAD",
        "",
      ].join("\n"),
    );

    expect(result.status).toBe(0);
  });
});

describe("package.json", () => {
  it("prepare installs the reference-transaction hook after husky, and skips both without husky", () => {
    const { scripts } = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    );

    expect(scripts.prepare).toBe(
      "command -v husky >/dev/null 2>&1 || exit 0; husky && node scripts/husky-extra-hooks.mjs",
    );
    expect(scripts.branch).toBe("node scripts/branch.mjs");
  });
});
