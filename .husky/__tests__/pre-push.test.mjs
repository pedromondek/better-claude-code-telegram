import { spawn, spawnSync } from "node:child_process";
import {
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

import { HUSKY_HOOK_ARGS } from "./support/husky-hook.mjs";

const PRE_PUSH = join(import.meta.dirname, "..", "pre-push");
const ZERO_OID = "0".repeat(40);
const BRANCH = "0001-feature";
const HOOK_TIMEOUT = 60_000;
const PASSING = {
  lint: "exit 0",
  "lint:secrets": "exit 0",
  "lint:typos": "exit 0",
  "lint:lockfile": "exit 0",
  "lint:workflows": "exit 0",
  "test:cov": "exit 0",
  "test:cov:changed": "exit 0",
  "test:mutation:prepush": "exit 0",
};
const STEPS = [
  "lint and typecheck",
  "secrets",
  "typos",
  "lockfile",
  "unit tests with coverage",
  "mutation",
];

let repo;
let hookTmp;

function git(...args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });

  if (result.status !== 0) throw new Error(result.stderr);

  return result.stdout.trim();
}

function useScripts(scripts) {
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "probe", scripts: { ...PASSING, ...scripts } }),
  );
  git("add", "package.json");
  git("commit", "-qm", "scripts");
}

function commitFile(file, content, message = file) {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), content);
  git("add", file);
  git("commit", "-qm", message);
}

function pushLine(remoteOid = ZERO_OID, remoteBranch = BRANCH) {
  return `refs/heads/${BRANCH} ${git("rev-parse", "HEAD")} refs/heads/${remoteBranch} ${remoteOid}\n`;
}

function push({ input = pushLine(), env = {} } = {}) {
  return spawnSync("sh", [...HUSKY_HOOK_ARGS, PRE_PUSH], {
    cwd: repo,
    input,
    encoding: "utf8",
    env: { ...process.env, CI: "", TMPDIR: hookTmp, ...env },
  });
}

function worktreeCount() {
  return git("worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;
}

function hookLeftovers() {
  return readdirSync(hookTmp).filter((entry) => entry !== "node-compile-cache");
}

function npmBanners(output) {
  return output.split("\n").filter((line) => line.startsWith("> "));
}

function killGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(file) {
  const deadline = Date.now() + 20_000;

  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`${file} did not show up`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "bcct-pre-push-"));
  hookTmp = mkdtempSync(join(tmpdir(), "bcct-pre-push-tmp-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  git("add", ".gitignore");
  git("commit", "-qm", "base");
  useScripts({});
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(hookTmp, { recursive: true, force: true });
});

describe(".husky/pre-push", { timeout: HOOK_TIMEOUT }, () => {
  describe("when every step passes", () => {
    it("announces each step as OK, lets the push through and leaves nothing behind", () => {
      const result = push();

      expect(result.status).toBe(0);
      for (const step of STEPS) {
        expect(result.stdout).toMatch(new RegExp(`^✓ ${step} OK$`, "mu"));
      }
      expect(result.stderr).toBe("");
      expect(worktreeCount()).toBe(1);
      expect(hookLeftovers()).toEqual([]);
    });
  });

  describe("when a step fails", () => {
    it("shows the output of the step without the npm banner, runs the other steps and stops the push with 1", () => {
      useScripts({
        lint: "echo 'scripts/a.mjs:1:1 LINT_FAILURE_MARKER' && exit 1",
        "lint:typos": "echo 'README.md:1 TYPO_MARKER' && exit 2",
      });

      const result = push();

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("✗ lint and typecheck failed");
      expect(result.stdout).toContain("scripts/a.mjs:1:1 LINT_FAILURE_MARKER");
      expect(result.stdout).toContain("✗ typos failed");
      expect(result.stdout).toContain("README.md:1 TYPO_MARKER");
      expect(result.stdout).toMatch(/^✓ unit tests with coverage OK$/mu);
      expect(result.stdout).toMatch(/^✗ push stopped$/mu);
      expect(npmBanners(result.stdout)).toEqual([]);
    });

    it("runs the coverage of the changed lines only after the tests pass", () => {
      useScripts({
        "test:cov": "exit 1",
        "test:cov:changed": "echo CHANGED_LINES_RAN",
      });

      const result = push();

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("✗ unit tests with coverage failed");
      expect(result.stdout).not.toContain("CHANGED_LINES_RAN");
    });

    it("fails the changed-lines check even when the tests pass", () => {
      useScripts({
        "test:cov:changed": "echo 'plugins/x.ts:3 UNCOVERED_MARKER' && exit 1",
      });

      const result = push();

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("UNCOVERED_MARKER");
    });

    it("does not run the mutation and lists the failures together", () => {
      useScripts({
        lint: "echo 'LINT_FAILURE_MARKER' && exit 1",
        "test:mutation:prepush": "echo 'MUTATION_RAN_MARKER'",
      });

      const result = push();

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("LINT_FAILURE_MARKER");
      expect(result.stdout).toMatch(/^✓ unit tests with coverage OK$/mu);
      expect(result.stdout).toMatch(/^✗ mutation skipped: fix the failures/mu);
      expect(result.stdout).toMatch(/^✗ push stopped$/mu);
      expect(result.stdout).not.toMatch(/MUTATION_RAN_MARKER|→ mutation/u);
    });

    it("says which npm script is missing instead of failing quietly", () => {
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ name: "probe", scripts: { lint: "exit 0" } }),
      );
      git("add", "package.json");
      git("commit", "-qm", "only lint");

      const result = push();

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        'npm script "lint:secrets" does not exist in package.json',
      );
    });
  });

  describe("mutation", () => {
    it("runs after every cheap step and shows its output without the npm banner", () => {
      useScripts({
        "test:mutation:prepush": "echo 'MUTATION_SURVIVOR_MARKER' && exit 1",
      });

      const result = push();

      expect(result.status).toBe(3);
      expect(result.stdout).toMatch(/^✗ mutation failed$/mu);
      expect(result.stdout).toContain("MUTATION_SURVIVOR_MARKER");
      expect(result.stdout).toMatch(/^✗ push stopped$/mu);
      expect(npmBanners(result.stdout)).toEqual([]);
      expect(
        result.stdout.indexOf("✓ unit tests with coverage OK"),
      ).toBeLessThan(result.stdout.indexOf("→ mutation..."));
    });

    it("leaves the push through with 0 when the mutation passes", () => {
      const result = push();

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/^→ mutation\.\.\.$/mu);
      expect(result.stdout).toMatch(/^✓ mutation OK$/mu);
    });

    it("with PREPUSH_SKIP_MUTATION=1 runs only the cheap steps and lets the push through without calling the mutation", () => {
      useScripts({
        "test:mutation:prepush": "echo 'MUTATION_RAN_MARKER' && exit 1",
      });

      const result = push({ env: { PREPUSH_SKIP_MUTATION: "1" } });

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/^✓ unit tests with coverage OK$/mu);
      expect(result.stdout).toContain(
        "mutation skipped (PREPUSH_SKIP_MUTATION=1)",
      );
      expect(result.stdout).not.toMatch(/MUTATION_RAN_MARKER|→ mutation/u);
    });

    it("with PREPUSH_SKIP_MUTATION=1 a cheap failure still exits with 1", () => {
      useScripts({ lint: "exit 1" });

      const result = push({ env: { PREPUSH_SKIP_MUTATION: "1" } });

      expect(result.status).toBe(1);
    });

    it("fails saying which npm script is missing", () => {
      const { "test:mutation:prepush": _missing, ...withoutMutation } = PASSING;
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ name: "probe", scripts: withoutMutation }),
      );
      git("add", "package.json");
      git("commit", "-qm", "no mutation");

      const result = push();

      expect(result.status).toBe(3);
      expect(result.stdout).toMatch(/^✗ mutation failed$/mu);
      expect(result.stdout).toContain(
        'npm script "test:mutation:prepush" does not exist in package.json',
      );
    });

    it("writes straight to the push output, without waiting for the end in a temporary file", () => {
      useScripts({
        "test:mutation:prepush": `node -e "console.log('MUTATION_STDOUT_IS_FILE=' + require('node:fs').fstatSync(1).isFile())"`,
      });

      const result = push();

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("MUTATION_STDOUT_IS_FILE=false");
      expect(result.stdout).toMatch(/^✓ mutation OK$/mu);
    });

    it("hands the exact range of the push to the mutation", () => {
      const remote = git("rev-parse", "HEAD");
      commitFile("a.txt", "a\n");
      useScripts({
        "test:mutation:prepush": 'echo "RANGE=$MUTATION_RANGE"',
      });

      const result = push({ input: pushLine(remote) });

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(
        new RegExp(
          `^RANGE=${remote}\\.\\.\\.${git("rev-parse", "HEAD")}$`,
          "mu",
        ),
      );
    });

    it("starts the mutation with the Stryker incremental of the main tree and hands it back updated", () => {
      useScripts({
        "test:mutation:prepush":
          "cat reports/stryker-incremental.json && echo v2 > reports/stryker-incremental.json",
      });
      mkdirSync(join(repo, "reports"), { recursive: true });
      writeFileSync(join(repo, "reports", "stryker-incremental.json"), "v1\n");

      const result = push();

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/^v1$/mu);
      expect(
        readFileSync(join(repo, "reports", "stryker-incremental.json"), "utf8"),
      ).toBe("v2\n");
    });

    it("hands the incremental back even when the mutation fails", () => {
      useScripts({
        "test:mutation:prepush":
          "echo v2 > reports/stryker-incremental.json && exit 1",
      });
      mkdirSync(join(repo, "reports"), { recursive: true });
      writeFileSync(join(repo, "reports", "stryker-incremental.json"), "v1\n");

      const result = push();

      expect(result.status).toBe(3);
      expect(
        readFileSync(join(repo, "reports", "stryker-incremental.json"), "utf8"),
      ).toBe("v2\n");
    });
  });

  describe("validates the pushed commit, not the working tree", () => {
    const LINT_READS_MARKER = "grep -q GREEN marker.txt";

    it("passes with the good commit even with a broken uncommitted change", () => {
      useScripts({ lint: LINT_READS_MARKER });
      commitFile("marker.txt", "GREEN\n");
      writeFileSync(join(repo, "marker.txt"), "RED\n");

      const result = push();

      expect(result.status).toBe(0);
      expect(worktreeCount()).toBe(1);
      expect(hookLeftovers()).toEqual([]);
    });

    it("stops the broken commit even with the working tree already fixed", () => {
      useScripts({ lint: LINT_READS_MARKER });
      commitFile("marker.txt", "RED\n");
      writeFileSync(join(repo, "marker.txt"), "GREEN\n");

      const result = push();

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("✗ lint and typecheck failed");
      expect(worktreeCount()).toBe(1);
    });

    it("runs the steps in the repository of the worktree even with the GIT_DIR git exports to the hook", () => {
      useScripts({
        lint: 'echo "GIT_DIR_SEEN=$(git rev-parse --git-dir)" && exit 1',
      });

      const result = push({ env: { GIT_DIR: join(repo, ".git") } });

      expect(result.stdout).toMatch(/^GIT_DIR_SEEN=.*\/worktrees\//mu);
      expect(worktreeCount()).toBe(1);
    });

    it("hands the exact range of the push to the coverage of the changed lines", () => {
      const remote = git("rev-parse", "HEAD");
      commitFile("a.txt", "a\n");
      useScripts({
        "test:cov:changed": 'echo "RANGE=$MUTATION_RANGE" && exit 1',
      });

      const result = push({ input: pushLine(remote) });

      expect(result.stdout).toContain(
        `RANGE=${remote}...${git("rev-parse", "HEAD")}`,
      );
    });

    it("locks the temporary worktree with the pid of the push while the steps run", () => {
      useScripts({
        lint: 'echo "LOCK=$(cat "$(git rev-parse --git-dir)/locked")" && exit 1',
      });

      expect(push().stdout).toMatch(/^LOCK=pre-push pid \d+$/mu);
      expect(worktreeCount()).toBe(1);
    });

    it("removes on the next push the worktree a dead push left behind, and leaves alone a live or foreign lock", () => {
      const deadPid = spawnSync("true").pid;
      const stale = join(hookTmp, "pre-push-worktree.stale");
      const other = join(hookTmp, "other-worktree");
      git(
        "worktree",
        "add",
        "--detach",
        "--quiet",
        "--lock",
        "--reason",
        `pre-push pid ${deadPid}`,
        stale,
        "HEAD",
      );
      git(
        "worktree",
        "add",
        "--detach",
        "--quiet",
        "--lock",
        "--reason",
        "external disk",
        other,
        "HEAD",
      );

      const result = push();

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "removed the worktree an interrupted push left behind",
      );
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(other)).toBe(true);
      expect(worktreeCount()).toBe(2);
    });

    it("removes the folder when the worktree of the pushed commit cannot be created", () => {
      const result = push({
        input: `refs/heads/${BRANCH} ${"1".repeat(40)} refs/heads/${BRANCH} ${ZERO_OID}\n`,
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        "✗ could not create the temporary worktree of the pushed commit",
      );
      expect(worktreeCount()).toBe(1);
      expect(hookLeftovers()).toEqual([]);
    });

    it.each(["lint", "test:mutation:prepush"])(
      "removes the temporary worktree when the push is stopped with Ctrl+C during %s",
      async (step) => {
        const started = join(repo, "step-started");
        useScripts({ [step]: `touch ${started} && sleep 30 && true` });
        const hook = spawn("sh", [...HUSKY_HOOK_ARGS, PRE_PUSH], {
          cwd: repo,
          env: { ...process.env, CI: "", TMPDIR: hookTmp },
          stdio: ["pipe", "ignore", "ignore"],
          detached: true,
        });
        const exited = new Promise((resolve) => hook.once("exit", resolve));
        hook.stdin.end(pushLine());

        try {
          await waitForFile(started);
          process.kill(-hook.pid, "SIGINT");

          expect(await exited).toBe(130);
        } finally {
          killGroup(hook.pid);
        }

        expect(worktreeCount()).toBe(1);
        expect(hookLeftovers()).toEqual([]);
      },
    );
  });

  describe("workflow linters", () => {
    it.each([
      ".github/workflows/ci.yml",
      ".github/actions/setup/action.yml",
      ".github/actionlint.yaml",
    ])("run when the push changes %s", (file) => {
      const remote = git("rev-parse", "HEAD");
      useScripts({ "lint:workflows": "echo WORKFLOWS_RAN && exit 1" });
      commitFile(file, "name: x\n");

      const result = push({ input: pushLine(remote) });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("✗ workflow linters failed");
      expect(result.stdout).toContain("WORKFLOWS_RAN");
    });

    it("do not run when the push does not touch a workflow", () => {
      commitFile(".github/workflows/ci.yml", "name: x\n");
      const remote = git("rev-parse", "HEAD");
      useScripts({ "lint:workflows": "echo WORKFLOWS_RAN && exit 1" });
      commitFile("README.md", "readme\n");

      const result = push({ input: pushLine(remote) });

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("workflow linters");
    });

    it("run, like every check, when the push has no reliable range", () => {
      useScripts({ "lint:workflows": "echo WORKFLOWS_RAN && exit 1" });
      commitFile(".github/workflows/ci.yml", "name: x\n");

      const result = push();

      expect(result.stdout).toContain("No reliable range");
      expect(result.stdout).toContain("WORKFLOWS_RAN");
    });
  });

  describe("progress of the test step", () => {
    const WRITE_PROGRESS = `node -e "require('node:fs').writeFileSync(process.env.TEST_PROGRESS_FILE, '1 1\\n')" --`;

    it("hands the progress file to the tests, shows the final count and time, and removes the file", () => {
      useScripts({ "test:cov": WRITE_PROGRESS });

      const result = push();

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(
        /^✓ unit tests with coverage OK \(1\/1\) 100% \[={20}\] 100% • \d+s$/mu,
      );
      expect(hookLeftovers()).toEqual([]);
    });

    it("runs the tests with the minimal reporter and the progress reporter", () => {
      useScripts({
        "test:cov": `node -e "console.log(['ARGS', ...process.argv.slice(1)].join(' ')); process.exit(1)" --`,
      });

      expect(push().stdout).toContain(
        "ARGS --reporter=minimal --reporter=./scripts/vitest-progress-reporter.mjs",
      );
    });
  });

  describe("branch name", () => {
    const BAD_BRANCH = "outside the pattern 0042-short-title";

    it("stops the push of a branch outside the pattern before any step", () => {
      const result = push({ input: pushLine(ZERO_OID, "my-branch") });

      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain(BAD_BRANCH);
      expect(result.stdout).not.toContain("lint and typecheck");
    });

    it.each([BRANCH, "main"])(
      "lets %s through, in the pattern or an exception",
      (remoteBranch) => {
        const result = push({ input: pushLine(ZERO_OID, remoteBranch) });

        expect(result.status).toBe(0);
        expect(result.stdout + result.stderr).not.toContain(BAD_BRANCH);
      },
    );

    it("lets the deletion of a branch outside the pattern through", () => {
      const result = push({
        input: `(delete) ${ZERO_OID} refs/heads/my-branch ${"1".repeat(40)}\n`,
      });

      expect(result.status).toBe(0);
    });

    it.each([{ CI: "true" }, { PREPUSH_SKIP_BRANCH_CHECK: "1" }])(
      "does not check the name with %o, as CI and check:commit run it",
      (env) => {
        const result = push({
          input: pushLine(ZERO_OID, "check-commit"),
          env,
        });

        expect(result.stdout + result.stderr).not.toContain(BAD_BRANCH);
      },
    );
  });

  describe("fixup commits", () => {
    const FUSE_ADVICE =
      /ℹ (\d+) fixup!\/squash!\/amend! on the branch: before the merge, fuse them with npm run fixup:fuse/u;

    it("counts the fixup!, squash! and amend! of the branch since main, and does not stop the push", () => {
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      commitFile("a.md", "a\n", "docs: a");
      commitFile("a.md", "a2\n", "fixup! docs: a");
      const alreadyPushed = git("rev-parse", "HEAD");
      commitFile("b.md", "b\n", "docs: b");
      commitFile("b.md", "b2\n", "squash! docs: b");
      commitFile("a.md", "a3\n", "amend! docs: a");

      const result = push({ input: pushLine(alreadyPushed) });

      expect(result.status).toBe(0);
      expect(result.stdout.match(FUSE_ADVICE)?.[1]).toBe("3");
    });

    it("says nothing about fusing when the branch has no fixup!", () => {
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      commitFile("a.md", "a\n", "docs: a");

      expect(push().stdout).not.toContain("fixup:fuse");
    });
  });
});
