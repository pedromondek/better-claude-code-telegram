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

const ROOT = join(import.meta.dirname, "..", "..");
const CHECK_COMMIT = join(ROOT, ".husky", "lib", "check-commit.sh");
const ROOT_SCRIPTS = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
).scripts;
const HOOK_TIMEOUT = 120_000;
const PASSING = {
  lint: "grep -q GREEN state.txt",
  "lint:secrets": "exit 0",
  "lint:typos": "exit 0",
  "lint:lockfile": "exit 0",
  "lint:plugins": "exit 0",
  "lint:workflows": "exit 0",
  "test:cov": "exit 0",
  "test:cov:changed": "exit 0",
  "rust:lint": "exit 0",
  "rust:deny": "exit 0",
  "rust:cov": "exit 0",
  "check:commit": `sh ${CHECK_COMMIT}`,
  "fixup:fuse": ROOT_SCRIPTS["fixup:fuse"],
};

let repo;
let hookTmp;

function git(...args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });

  if (result.status !== 0) throw new Error(result.stderr);

  return result.stdout.trim();
}

function commitFile(file, content, message = file) {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), content);
  git("add", file);
  git("commit", "-qm", message);
}

function env() {
  return { ...process.env, CI: "", TMPDIR: hookTmp };
}

function checkCommit(...args) {
  return spawnSync("sh", [CHECK_COMMIT, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: env(),
  });
}

function fuse() {
  return spawnSync("npm", ["run", "--silent", "fixup:fuse"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...env(), GIT_EDITOR: "false", EDITOR: "false" },
  });
}

function checkRunsFile() {
  return join(hookTmp, "check-commit-runs");
}

function checkRuns() {
  return existsSync(checkRunsFile())
    ? readFileSync(checkRunsFile(), "utf8").trim().split("\n").length
    : 0;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "bcct-check-commit-"));
  hookTmp = mkdtempSync(join(tmpdir(), "bcct-check-commit-tmp-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      name: "probe",
      scripts: {
        ...PASSING,
        "check:commit": `echo run >> '${checkRunsFile()}' && sh ${CHECK_COMMIT}`,
      },
    }),
  );
  writeFileSync(join(repo, "state.txt"), "GREEN\n");
  git("add", ".gitignore", "package.json", "state.txt");
  git("commit", "-qm", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(hookTmp, { recursive: true, force: true });
});

describe("check:commit", { timeout: HOOK_TIMEOUT }, () => {
  it("runs the push checks on the last commit and fails when it is red", () => {
    commitFile("state.txt", "RED\n");

    const result = checkCommit();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("✗ lint and typecheck failed");
  });

  it("passes on a green last commit, with no branch check for its fictitious ref", () => {
    commitFile("state.txt", "RED\n");
    commitFile("state.txt", "GREEN again\n");

    const result = checkCommit();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("✓ lint and typecheck OK");
    expect(result.stdout).toContain("✓ rust lint OK");
    expect(result.stdout).toContain("✓ rust dependencies OK");
    expect(result.stdout).toContain("✓ rust tests with coverage OK");
    expect(result.stdout).not.toContain("rust mutation");
    expect(result.stdout + result.stderr).not.toContain("outside the pattern");
  });

  it("checks the commit it gets, not HEAD, without switching branch or touching the working tree", () => {
    commitFile("state.txt", "RED\n", "feat: red");
    const red = git("rev-parse", "HEAD");
    commitFile("state.txt", "GREEN fixed\n", "fix: green");
    const head = git("rev-parse", "HEAD");

    const result = checkCommit(red);

    expect(result.status).toBe(1);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(repo, "state.txt"), "utf8")).toBe("GREEN fixed\n");
    expect(git("status", "--porcelain")).toBe("");
  });

  it("fails with a clear message when the commit does not exist", () => {
    const result = checkCommit("does-not-exist");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("commit does-not-exist not found");
  });

  it("fails with a clear message when the commit has no parent", () => {
    const result = checkCommit(git("rev-list", "--max-parents=0", "HEAD"));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("has no parent commit to compare with");
  });

  it("is the check:commit npm script", () => {
    expect(ROOT_SCRIPTS["check:commit"]).toBe("sh .husky/lib/check-commit.sh");
  });
});

describe("npm run fixup:fuse", { timeout: HOOK_TIMEOUT }, () => {
  it("fuses each fixup! into its commit and runs check:commit once, on the fused HEAD, without opening an editor", () => {
    const base = git("rev-parse", "HEAD");
    commitFile("state.txt", "RED\n", "feat: red");
    git("commit", "-q", "--allow-empty", "-m", "feat: other");
    git("commit", "-q", "--allow-empty", "-m", "feat: docs");
    commitFile("state.txt", "GREEN fixed\n", "fixup! feat: red");

    const result = fuse();

    expect(result.status).toBe(0);
    expect(git("log", "--format=%s", `${base}..HEAD`).split("\n")).toEqual([
      "feat: docs",
      "feat: other",
      "feat: red",
    ]);
    expect(checkRuns()).toBe(1);
  });

  it("fails when the fused HEAD is red, with the fusion already done", () => {
    const base = git("rev-parse", "HEAD");
    commitFile("other.txt", "x\n", "feat: other");
    commitFile("state.txt", "RED\n", "feat: red");

    const result = fuse();

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "✗ lint and typecheck failed",
    );
    expect(existsSync(join(repo, ".git", "rebase-merge"))).toBe(false);
    expect(git("rev-list", "--count", `${base}..HEAD`)).toBe("2");
    expect(checkRuns()).toBe(1);
  });

  it("stops at a rebase conflict, leaves the rebase for the dev to resolve and does not run check:commit", () => {
    commitFile("notes.txt", "a\n", "feat: a");
    commitFile("notes.txt", "b\n", "feat: b");
    commitFile("notes.txt", "c\n", "fixup! feat: a");

    const result = fuse();

    expect(result.status).not.toBe(0);
    expect(existsSync(join(repo, ".git", "rebase-merge"))).toBe(true);
    expect(checkRuns()).toBe(0);
    git("rebase", "--abort");
  });

  it("keeps the base of the branch: it does not bring in what main got afterwards", () => {
    const base = git("rev-parse", "HEAD");
    commitFile("state.txt", "GREEN again\n", "feat: green");
    commitFile("state.txt", "GREEN fixed\n", "fixup! feat: green");
    const feature = git("rev-parse", "HEAD");
    git("checkout", "-q", "--detach", base);
    commitFile("main.txt", "main\n", "chore: main moved");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("checkout", "-q", feature);

    const result = fuse();

    expect(result.status).toBe(0);
    expect(git("rev-parse", "HEAD~1")).toBe(base);
    expect(existsSync(join(repo, "main.txt"))).toBe(false);
  });

  it("does not run the pre-commit hook on the commits the rebase replays", () => {
    const hooks = join(repo, ".hooks");
    const marker = join(repo, "pre-commit-ran");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(join(hooks, "pre-commit"), 0o755);
    commitFile("state.txt", "GREEN again\n", "feat: green");
    commitFile("state.txt", "GREEN fixed\n", "fixup! feat: green");
    git("config", "core.hooksPath", hooks);

    const result = fuse();

    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});
