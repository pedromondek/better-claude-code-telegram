import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { pushRange } from "../push-range.mjs";

const PUSH_RANGE = pathToFileURL(
  join(import.meta.dirname, "..", "push-range.mjs"),
).href;

const UPSTREAM = "rev-parse --abbrev-ref --symbolic-full-name @{upstream}";
const MERGE_BASE = "merge-base origin/main HEAD";

function gitAnswering(answers) {
  const calls = [];
  const run = (args) => {
    const command = args.join(" ");
    calls.push(command);

    return answers[command] ?? "";
  };

  return { run, calls };
}

describe("pushRange", () => {
  it("uses MUTATION_RANGE without asking git", () => {
    const git = gitAnswering({});

    expect(
      pushRange({ env: { MUTATION_RANGE: "abc..def" }, run: git.run }),
    ).toBe("abc..def");
    expect(git.calls).toEqual([]);
  });

  it("compares with the upstream of the branch when there is one", () => {
    const git = gitAnswering({ [UPSTREAM]: "origin/0001-feature\n" });

    expect(pushRange({ env: {}, run: git.run })).toBe(
      "origin/0001-feature...HEAD",
    );
  });

  it("falls back to the merge base with origin/main when the branch has no upstream", () => {
    const git = gitAnswering({ [MERGE_BASE]: "1234abcd\n" });

    expect(pushRange({ env: {}, run: git.run })).toBe("1234abcd...HEAD");
    expect(git.calls).toEqual([UPSTREAM, MERGE_BASE]);
  });

  it("falls back to the last commit when there is neither upstream nor base", () => {
    expect(pushRange({ env: {}, run: gitAnswering({}).run })).toBe(
      "HEAD~1..HEAD",
    );
  });

  it("falls back quietly in a real repository with no upstream and no origin/main, without git errors on stderr", () => {
    const repo = mkdtempSync(join(tmpdir(), "bcct-push-range-"));

    try {
      execFileSync("git", ["init", "-q", "-b", "0001-feature"], { cwd: repo });
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const { pushRange } = await import(${JSON.stringify(PUSH_RANGE)}); console.log(pushRange({ env: {} }));`,
        ],
        { cwd: repo, encoding: "utf8" },
      );

      expect(result.stdout).toBe("HEAD~1..HEAD\n");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
