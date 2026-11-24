import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  UNLOCK_GH_TIMEOUT_MS,
  githubFrom,
  run,
} from "../unlock-pull-request.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const BRANCH = "0001-feature";

function ghError({ code, stderr = "", message = "Command failed: gh api" }) {
  return Object.assign(new Error(message), { code, stderr });
}

function fakeGithub({ open = {}, fails = {} } = {}) {
  const calls = [];
  const github = {
    openPullRequestsOf: (branch) => {
      calls.push(["openPullRequestsOf", branch]);
      if (fails.list !== undefined) throw fails.list;
      return open[branch] ?? [];
    },
    unlock: (number) => {
      calls.push(["unlock", number]);
      if (fails.unlock !== undefined) throw fails.unlock;
    },
  };

  return { github, calls };
}

function unlockWith({ args = [BRANCH], env = {}, github: options } = {}) {
  const { github, calls } = fakeGithub(options);
  const out = [];
  const err = [];
  const code = run(args, {
    env,
    github,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

  return { code, out, err, calls };
}

const pullRequest = (number, locked) => ({ number, locked, head: "abc1234" });

describe("pr:unlock › the open pull request of the pushed branch", () => {
  it("unlocks a locked pull request, so CodeRabbit reviews the push", () => {
    const { code, out, err, calls } = unlockWith({
      github: { open: { [BRANCH]: [pullRequest(12, true)] } },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      ["openPullRequestsOf", BRANCH],
      ["unlock", 12],
    ]);
    expect(out).toEqual([
      "✓ #12 unlocked, so CodeRabbit reviews this push",
      "  if this push does not reach GitHub, lock it again with: gh workflow run lock-pull-requests.yml",
    ]);
    expect(err).toEqual([]);
  });

  it("leaves a pull request that is not locked as it is", () => {
    const { code, out, calls } = unlockWith({
      github: { open: { [BRANCH]: [pullRequest(12, false)] } },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([["openPullRequestsOf", BRANCH]]);
    expect(out).toEqual(["- #12 is not locked"]);
  });

  it("says so when the branch has no open pull request", () => {
    const { code, out, calls } = unlockWith();

    expect(code).toBe(0);
    expect(calls).toEqual([["openPullRequestsOf", BRANCH]]);
    expect(out).toEqual([`- no open pull request from ${BRANCH}`]);
  });

  it("unlocks each locked pull request of each pushed branch", () => {
    const { code, calls } = unlockWith({
      args: [BRANCH, "0002-other"],
      github: {
        open: {
          [BRANCH]: [pullRequest(12, true), pullRequest(13, false)],
          "0002-other": [pullRequest(14, true)],
        },
      },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      ["openPullRequestsOf", BRANCH],
      ["unlock", 12],
      ["openPullRequestsOf", "0002-other"],
      ["unlock", 14],
    ]);
  });
});

describe("pr:unlock › never fails the push", () => {
  it("tells that gh is not installed and exits 0", () => {
    const { code, out, err } = unlockWith({
      github: {
        fails: {
          list: ghError({ code: "ENOENT", message: "spawnSync gh ENOENT" }),
        },
      },
    });

    expect(code).toBe(0);
    expect(out).toEqual([
      `⚠ the pull request of ${BRANCH} stays as it is: gh is not installed`,
    ]);
    expect(err).toEqual([]);
  });

  it("tells that gh took longer than its 15 seconds and exits 0", () => {
    const { code, out } = unlockWith({
      github: {
        fails: {
          list: ghError({
            code: "ETIMEDOUT",
            message: "spawnSync gh ETIMEDOUT",
          }),
        },
      },
    });

    expect(code).toBe(0);
    expect(UNLOCK_GH_TIMEOUT_MS).toBe(15_000);
    expect(out).toEqual([
      `⚠ the pull request of ${BRANCH} stays as it is: gh did not answer within 15 seconds`,
    ]);
  });

  it("shows the first line gh printed when it is not logged in, and exits 0", () => {
    const { code, out } = unlockWith({
      github: {
        fails: {
          list: ghError({
            code: 4,
            stderr:
              "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable.\n",
          }),
        },
      },
    });

    expect(code).toBe(0);
    expect(out).toEqual([
      `⚠ the pull request of ${BRANCH} stays as it is: To get started with GitHub CLI, please run:  gh auth login`,
    ]);
  });

  it("shows the first line of the error when gh printed nothing, and exits 0", () => {
    const { code, out } = unlockWith({
      github: {
        fails: {
          list: ghError({
            code: 1,
            message: "Command failed: gh api\nsecond line",
          }),
        },
      },
    });

    expect(code).toBe(0);
    expect(out).toEqual([
      `⚠ the pull request of ${BRANCH} stays as it is: Command failed: gh api`,
    ]);
  });

  it("tells the error of GitHub when the unlock fails, and exits 0", () => {
    const { code, out, calls } = unlockWith({
      github: {
        open: { [BRANCH]: [pullRequest(12, true)] },
        fails: {
          unlock: ghError({
            code: 1,
            stderr: "gh: Resource not accessible by integration (HTTP 403)\n",
          }),
        },
      },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      ["openPullRequestsOf", BRANCH],
      ["unlock", 12],
    ]);
    expect(out).toEqual([
      `⚠ the pull request of ${BRANCH} stays as it is: gh: Resource not accessible by integration (HTTP 403)`,
    ]);
  });

  it("shows an error that is not an Error as text", () => {
    const { code, out } = unlockWith({
      github: { fails: { list: "boom" } },
    });

    expect(code).toBe(0);
    expect(out).toEqual([
      `⚠ the pull request of ${BRANCH} stays as it is: boom`,
    ]);
  });
});

describe("pr:unlock › does nothing outside a real push of the developer", () => {
  it.each([{ CI: "true" }, { PREPUSH_SKIP_PR_UNLOCK: "1" }])(
    "skips silently with %o, as CI and check:commit run the pre-push",
    (env) => {
      const { code, out, err, calls } = unlockWith({
        env,
        github: { open: { [BRANCH]: [pullRequest(12, true)] } },
      });

      expect(code).toBe(0);
      expect(calls).toEqual([]);
      expect(out).toEqual([]);
      expect(err).toEqual([]);
    },
  );

  it.each([{ CI: "" }, { PREPUSH_SKIP_PR_UNLOCK: "" }])(
    "unlocks when %o is set but empty",
    (env) => {
      const { calls } = unlockWith({
        env,
        github: { open: { [BRANCH]: [pullRequest(12, true)] } },
      });

      expect(calls).toContainEqual(["unlock", 12]);
    },
  );

  it("refuses to run without a branch, without calling GitHub", () => {
    const { code, err, calls } = unlockWith({ args: [] });

    expect(code).toBe(2);
    expect(err).toEqual(["usage: npm run pr:unlock -- <branch>..."]);
    expect(calls).toEqual([]);
  });
});

function fakeGh(output = "") {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    return output;
  };

  return { gh, calls };
}

describe("pr:unlock › the gh calls", () => {
  it("lists the open pull requests whose head is the branch in this repository", () => {
    const { gh, calls } = fakeGh(
      JSON.stringify([
        { number: 12, locked: true, head: { sha: "abc1234" }, title: "x" },
      ]),
    );

    expect(githubFrom(gh).openPullRequestsOf("0001-a/b")).toEqual([
      pullRequest(12, true),
    ]);
    expect(calls).toEqual([
      [
        "api",
        "repos/{owner}/{repo}/pulls?state=open&head={owner}:0001-a%2Fb&per_page=100",
      ],
    ]);
  });

  it("unlocks the conversation through the lock of its issue", () => {
    const { gh, calls } = fakeGh();

    githubFrom(gh).unlock(12);

    expect(calls).toEqual([
      ["api", "--method", "DELETE", "repos/{owner}/{repo}/issues/12/lock"],
    ]);
  });
});

describe("pr:unlock › run", () => {
  it("is the pr:unlock npm script", () => {
    const { scripts } = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    );

    expect(scripts["pr:unlock"]).toBe("node scripts/unlock-pull-request.mjs");
  });
});
