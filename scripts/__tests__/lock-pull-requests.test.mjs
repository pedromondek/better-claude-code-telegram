import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { run } from "../lock-pull-requests.mjs";

const ROOT = join(import.meta.dirname, "..", "..");

function fakeGithub({ open = [], fails = null } = {}) {
  const calls = [];
  const byNumber = new Map(open.map((pr) => [pr.number, pr]));
  const github = {
    pullRequest: (number) => {
      calls.push(["pullRequest", number]);
      if (fails === "read") {
        throw new Error("HTTP 404: Not Found");
      }
      return byNumber.get(number);
    },
    openPullRequests: () => {
      calls.push(["openPullRequests"]);
      return open;
    },
    lock: (number) => {
      calls.push(["lock", number]);
      if (fails === "lock") {
        throw new Error("HTTP 403: Resource not accessible by integration");
      }
    },
  };

  return { github, calls };
}

function lockWith({ args = [], env = {}, github: options } = {}) {
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

const locks = (calls) =>
  calls.filter(([name]) => name === "lock").map(([, number]) => number);

describe("pr:lock › the pull request of the event", () => {
  it("locks the pull request in PR_NUMBER, so only who has write access comments on it", () => {
    const { code, out, calls } = lockWith({
      env: { PR_NUMBER: "12" },
      github: { open: [{ number: 12, locked: false }] },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      ["pullRequest", 12],
      ["lock", 12],
    ]);
    expect(out).toEqual(["✓ #12 locked"]);
  });

  it("leaves a pull request that is already locked alone", () => {
    const { code, out, calls } = lockWith({
      env: { PR_NUMBER: "12" },
      github: { open: [{ number: 12, locked: true }] },
    });

    expect(code).toBe(0);
    expect(locks(calls)).toEqual([]);
    expect(out).toEqual(["- #12 is already locked"]);
  });

  it.each(["12a", "-1", "0", " 12"])(
    "refuses a PR_NUMBER that is not a pull request number (%j), without locking anything",
    (number) => {
      const { code, err, calls } = lockWith({ env: { PR_NUMBER: number } });

      expect(code).toBe(1);
      expect(err).toEqual([
        `✗ PR_NUMBER must be the number of a pull request, not "${number}"`,
      ]);
      expect(calls).toEqual([]);
    },
  );

  it("reports the error of GitHub when the pull request cannot be read or locked", () => {
    const read = lockWith({
      env: { PR_NUMBER: "12" },
      github: { fails: "read" },
    });
    const lock = lockWith({
      env: { PR_NUMBER: "12" },
      github: { open: [{ number: 12, locked: false }], fails: "lock" },
    });

    expect(read).toMatchObject({ code: 1, err: ["✗ HTTP 404: Not Found"] });
    expect(lock).toMatchObject({
      code: 1,
      err: ["✗ HTTP 403: Resource not accessible by integration"],
    });
  });
});

describe("pr:lock › every open pull request, by hand", () => {
  it("locks each open pull request that is not locked yet, when no PR_NUMBER comes", () => {
    const { code, out, calls } = lockWith({
      env: { PR_NUMBER: "" },
      github: {
        open: [
          { number: 14, locked: false },
          { number: 9, locked: true },
          { number: 7, locked: false },
        ],
      },
    });

    expect(code).toBe(0);
    expect(calls[0]).toEqual(["openPullRequests"]);
    expect(locks(calls)).toEqual([14, 7]);
    expect(out).toEqual([
      "✓ #14 locked",
      "- #9 is already locked",
      "✓ #7 locked",
    ]);
  });

  it("says so when there is no open pull request", () => {
    const { code, out, calls } = lockWith();

    expect(code).toBe(0);
    expect(locks(calls)).toEqual([]);
    expect(out).toEqual(["- no open pull request"]);
  });
});

describe("pr:lock › run", () => {
  it("takes no argument, since the pull request comes in PR_NUMBER", () => {
    expect(lockWith({ args: ["12"] })).toMatchObject({
      code: 2,
      err: [
        "usage: npm run pr:lock (pull request in PR_NUMBER, or every open one without it)",
      ],
    });
  });

  it("is the pr:lock npm script", () => {
    const { scripts } = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    );

    expect(scripts["pr:lock"]).toBe("node scripts/lock-pull-requests.mjs");
  });
});
