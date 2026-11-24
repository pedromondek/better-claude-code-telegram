import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  gitVariablesIn,
  isolateHome,
  PRE_PUSH_CONTROL_VARIABLES,
} from "../../vitest.setup.ts";

let dir;

function git(...args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bcct-vitest-setup-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("vitest.setup", () => {
  it("finds every git variable of an environment, the repository-local ones and the ones git exports to its hooks", () => {
    expect(
      gitVariablesIn({
        GIT_DIR: "/repo/.git",
        GIT_INDEX_FILE: "/repo/.git/index",
        GIT_AUTHOR_EMAIL: "dev@example.com",
        GIT_COMMITTER_NAME: "dev",
        GIT_EDITOR: ":",
        PATH: "/bin",
        HOME: "/home/dev",
        MY_GIT_TOKEN: "x",
      }),
    ).toEqual([
      "GIT_DIR",
      "GIT_INDEX_FILE",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_EDITOR",
    ]);
  });

  it("leaves no git variable in the test process", () => {
    expect(gitVariablesIn(process.env)).toEqual([]);
  });

  it("removes the variables the pre-push exports or CI sets for its own run, so a test never inherits the range or a skipped step", () => {
    expect(PRE_PUSH_CONTROL_VARIABLES).toEqual([
      "PREPUSH_SKIP_MUTATION",
      "PREPUSH_SKIP_BRANCH_CHECK",
      "PREPUSH_SKIP_PR_UNLOCK",
      "MUTATION_RANGE",
      "MUTATION_BEFORE",
      "MUTATION_FORCE",
      "COVERAGE_RANGE",
      "TEST_PROGRESS_FILE",
    ]);
    expect(
      PRE_PUSH_CONTROL_VARIABLES.filter((name) => name in process.env),
    ).toEqual([]);
  });

  it("keeps a test git repository away from the index of the repository that runs the suite", () => {
    git("init", "-q");

    expect(git("rev-parse", "--absolute-git-dir")).toBe(join(dir, ".git"));
  });

  it("gives a test git repository the identity of its own config, not the one of the commit that runs the suite", () => {
    git("init", "-q");
    git("config", "user.name", "probe");
    git("config", "user.email", "probe@example.com");

    expect(git("var", "GIT_AUTHOR_IDENT")).toMatch(
      /^probe <probe@example\.com> /,
    );
    expect(git("var", "GIT_COMMITTER_IDENT")).toMatch(
      /^probe <probe@example\.com> /,
    );
  });

  it("creates the isolated HOME under the given folder and removes it with everything inside", () => {
    const { home, remove } = isolateHome(dir);

    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), "{}");

    expect(home.startsWith(join(dir, "bcct-home-"))).toBe(true);

    remove();

    expect(existsSync(home)).toBe(false);
  });

  it("points HOME to a temporary folder", () => {
    expect(process.env.HOME).toMatch(/bcct-home-/);
    expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(process.env.TELEGRAM_STATE_DIR).toBeUndefined();
  });
});
