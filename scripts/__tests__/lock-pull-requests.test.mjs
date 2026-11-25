import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { githubFrom, run } from "../lock-pull-requests.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const HEAD = "abc1234def5678abc1234def5678abc1234def56";
const NEXT_HEAD = "fed9876cba5432fed9876cba5432fed9876cba54";
const EVENT_ENV = { PR_NUMBER: "12", HEAD_SHA: HEAD };
const MOVED = "- #12 moved on to fed9876, the run of that push locks it";
const POLL_MS = 30_000;
const CAP_MS = 20 * 60_000;

const coderabbit = (status, conclusion = null) => ({
  app: "coderabbitai",
  status,
  conclusion,
});

function fakeGithub({
  open = [],
  fails = [],
  polls = [],
  readsBeforeFailure = Infinity,
} = {}) {
  const calls = [];
  const byNumber = new Map(open.map((pr) => [pr.number, { ...pr }]));
  let poll = 0;
  let reads = 0;
  const failWith = (step, message) => {
    if (fails.includes(step)) {
      throw new Error(message);
    }
  };
  const github = {
    pullRequest: (number) => {
      calls.push(["pullRequest", number]);
      failWith("read", "HTTP 404: Not Found");
      reads += 1;
      if (reads > readsBeforeFailure) {
        throw new Error("HTTP 500: Internal Server Error");
      }
      return { ...byNumber.get(number) };
    },
    openPullRequests: () => {
      calls.push(["openPullRequests"]);
      return open;
    },
    checkRuns: (sha) => {
      calls.push(["checkRuns", sha]);
      failWith("checks", "HTTP 502: Bad Gateway");
      const runs = polls[Math.min(poll, polls.length - 1)] ?? [];
      poll += 1;
      return runs;
    },
    unlock: (number) => {
      calls.push(["unlock", number]);
      byNumber.get(number).locked = false;
    },
    lock: (number) => {
      calls.push(["lock", number]);
      failWith("lock", "HTTP 403: Resource not accessible by integration");
      byNumber.get(number).locked = true;
    },
  };

  return { github, calls, byNumber };
}

function lockWith({
  args = [],
  env = {},
  github: options,
  drift = 0,
  onSleep = () => undefined,
} = {}) {
  const { github, calls, byNumber } = fakeGithub(options);
  const out = [];
  const err = [];
  const sleeps = [];
  let now = 0;
  const code = run(args, {
    env,
    github,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    clock: () => now,
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms + drift;
      onSleep(byNumber);
    },
  });

  return { code, out, err, calls, sleeps, byNumber };
}

const named = (calls, wanted) =>
  calls.filter(([name]) => name === wanted).map(([, value]) => value);

const event = (options, drift = 0) =>
  lockWith({ env: EVENT_ENV, github: options, drift });

const pullRequest = (locked) => ({ number: 12, locked, head: HEAD });

describe("pr:lock › the pull request of the event, after the CodeRabbit review", () => {
  it("locks right away when the CodeRabbit check of the head already completed", () => {
    const { code, out, calls, sleeps } = event({
      open: [pullRequest(false)],
      polls: [[coderabbit("completed", "success")]],
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      ["pullRequest", 12],
      ["checkRuns", HEAD],
      ["pullRequest", 12],
      ["lock", 12],
    ]);
    expect(sleeps).toEqual([]);
    expect(out).toEqual([
      "- waiting for the CodeRabbit review of abc1234 on #12",
      "✓ CodeRabbit finished on abc1234 (success)",
      "✓ #12 locked",
    ]);
  });

  it("polls the CodeRabbit check every 30 seconds and locks once it completes", () => {
    const { code, out, calls, sleeps, byNumber } = event({
      open: [pullRequest(false)],
      polls: [
        [],
        [coderabbit("queued")],
        [coderabbit("in_progress")],
        [coderabbit("completed", "failure")],
      ],
    });

    expect(code).toBe(0);
    expect(named(calls, "unlock")).toEqual([]);
    expect(named(calls, "checkRuns")).toHaveLength(4);
    expect(calls.at(-1)).toEqual(["lock", 12]);
    expect(sleeps).toEqual([POLL_MS, POLL_MS, POLL_MS]);
    expect(byNumber.get(12).locked).toBe(true);
    expect(out).toEqual([
      "- waiting for the CodeRabbit review of abc1234 on #12",
      "✓ CodeRabbit finished on abc1234 (failure)",
      "✓ #12 locked",
    ]);
  });

  it("takes a skipped CodeRabbit check as completed", () => {
    const { code, out, sleeps } = event({
      open: [pullRequest(false)],
      polls: [[coderabbit("completed", "skipped")]],
    });

    expect(code).toBe(0);
    expect(sleeps).toEqual([]);
    expect(out).toContain("✓ CodeRabbit finished on abc1234 (skipped)");
  });

  it("waits until every CodeRabbit check of the head completes", () => {
    const { out, sleeps } = event({
      open: [pullRequest(false)],
      polls: [
        [coderabbit("completed", "success"), coderabbit("in_progress")],
        [
          coderabbit("completed", "success"),
          coderabbit("completed", "neutral"),
        ],
      ],
    });

    expect(sleeps).toEqual([POLL_MS]);
    expect(out).toContain(
      "✓ CodeRabbit finished on abc1234 (success, neutral)",
    );
  });

  it("locks with a warning when the CodeRabbit check never appears before the cap", () => {
    const { code, out, calls, sleeps } = event({
      open: [pullRequest(false)],
      polls: [
        [{ app: "other-app", status: "completed", conclusion: "success" }],
      ],
    });

    expect(code).toBe(0);
    expect(sleeps).toHaveLength(CAP_MS / POLL_MS);
    expect(sleeps.reduce((total, ms) => total + ms, 0)).toBe(CAP_MS);
    expect(named(calls, "checkRuns")).toHaveLength(CAP_MS / POLL_MS + 1);
    expect(named(calls, "lock")).toEqual([12]);
    expect(out.slice(1)).toEqual([
      "::warning::The CodeRabbit check did not appear on abc1234 within 20 minutes, so #12 is locked without its review",
      "✓ #12 locked",
    ]);
  });

  it("locks with a warning when the CodeRabbit review does not finish before the cap", () => {
    const { code, out, calls } = event({
      open: [pullRequest(false)],
      polls: [[coderabbit("in_progress")]],
    });

    expect(code).toBe(0);
    expect(named(calls, "lock")).toEqual([12]);
    expect(out.slice(1)).toEqual([
      "::warning::The CodeRabbit review of abc1234 did not finish within 20 minutes, so #12 is locked without it",
      "✓ #12 locked",
    ]);
  });

  it("sleeps only the 22 seconds left of the cap when each poll takes a second more", () => {
    const { code, out, calls, sleeps } = event(
      { open: [pullRequest(false)], polls: [[coderabbit("in_progress")]] },
      1_000,
    );

    expect(code).toBe(0);
    expect(sleeps).toHaveLength(39);
    expect(sleeps.slice(0, -1).every((ms) => ms === POLL_MS)).toBe(true);
    expect(sleeps.at(-1)).toBe(22_000);
    expect(named(calls, "checkRuns")).toHaveLength(39);
    expect(named(calls, "lock")).toEqual([12]);
    expect(out.at(-2)).toBe(
      "::warning::The CodeRabbit review of abc1234 did not finish within 20 minutes, so #12 is locked without it",
    );
  });

  it("starts no poll once a sleep ends past the cap, and still locks", () => {
    const { github, calls } = fakeGithub({
      open: [pullRequest(false)],
      polls: [[coderabbit("in_progress")]],
    });
    let now = 0;

    const code = run([], {
      env: EVENT_ENV,
      github,
      out: () => undefined,
      err: () => undefined,
      clock: () => now,
      sleep: () => {
        now = CAP_MS + 1;
      },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      ["pullRequest", 12],
      ["checkRuns", HEAD],
      ["pullRequest", 12],
      ["pullRequest", 12],
      ["lock", 12],
    ]);
  });

  it("polls once more when a sleep ends exactly at the cap", () => {
    const { github, calls } = fakeGithub({
      open: [pullRequest(false)],
      polls: [
        [coderabbit("in_progress")],
        [coderabbit("completed", "success")],
      ],
    });
    let now = 0;
    const out = [];

    run([], {
      env: EVENT_ENV,
      github,
      out: (line) => out.push(line),
      err: () => undefined,
      clock: () => now,
      sleep: () => {
        now = CAP_MS;
      },
    });

    expect(named(calls, "checkRuns")).toHaveLength(2);
    expect(out).toContain("✓ CodeRabbit finished on abc1234 (success)");
  });
});

const SKIPPED_WARNING =
  "::warning::The push of abc1234 reached #12 locked, so CodeRabbit skipped its review; a person can unlock #12 and comment @coderabbitai review";

describe("pr:lock › the pull request of the event, locked when the push reached it", () => {
  it("keeps it locked without a warning when CodeRabbit already finished the head", () => {
    const { code, out, err, calls, sleeps, byNumber } = event({
      open: [pullRequest(true)],
      polls: [[coderabbit("completed", "success")]],
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      ["pullRequest", 12],
      ["checkRuns", HEAD],
    ]);
    expect(sleeps).toEqual([]);
    expect(byNumber.get(12).locked).toBe(true);
    expect(out).toEqual([
      "- #12 is already locked and CodeRabbit finished on abc1234 (success)",
    ]);
    expect(err).toEqual([]);
  });

  it("names only the conclusions of the CodeRabbit checks that did not skip", () => {
    const { code, out } = event({
      open: [pullRequest(true)],
      polls: [
        [
          coderabbit("completed", "skipped"),
          coderabbit("completed", "failure"),
          coderabbit("completed", "neutral"),
        ],
      ],
    });

    expect(code).toBe(0);
    expect(out).toEqual([
      "- #12 is already locked and CodeRabbit finished on abc1234 (failure, neutral)",
    ]);
  });

  it.each([
    ["skipped", [coderabbit("completed", "skipped")]],
    ["absent", []],
    ["in progress", [coderabbit("in_progress")]],
    [
      "from another app",
      [{ app: "other-app", status: "completed", conclusion: "success" }],
    ],
  ])(
    "warns that CodeRabbit skipped the push when its check is %s, and keeps it locked",
    (_state, runs) => {
      const { code, out, err, calls, sleeps, byNumber } = event({
        open: [pullRequest(true)],
        polls: [runs],
      });

      expect(code).toBe(0);
      expect(calls).toEqual([
        ["pullRequest", 12],
        ["checkRuns", HEAD],
        ["pullRequest", 12],
      ]);
      expect(sleeps).toEqual([]);
      expect(byNumber.get(12).locked).toBe(true);
      expect(out).toEqual([SKIPPED_WARNING, "- #12 is already locked"]);
      expect(err).toEqual([]);
    },
  );

  it("warns, keeps it locked and fails when the check runs of the head cannot be read", () => {
    const { code, out, err, calls, byNumber } = event({
      open: [pullRequest(true)],
      fails: ["checks"],
    });

    expect(code).toBe(1);
    expect(calls).toEqual([
      ["pullRequest", 12],
      ["checkRuns", HEAD],
      ["pullRequest", 12],
    ]);
    expect(byNumber.get(12).locked).toBe(true);
    expect(out).toEqual([SKIPPED_WARNING, "- #12 is already locked"]);
    expect(err).toEqual(["✗ HTTP 502: Bad Gateway"]);
  });
});

describe("pr:lock › the pull request of the event, once a newer push moved its head", () => {
  it("leaves the lock to the newer run when the head already moved", () => {
    const { code, out, calls, byNumber } = event({
      open: [{ ...pullRequest(false), head: NEXT_HEAD }],
    });

    expect(code).toBe(0);
    expect(calls).toEqual([["pullRequest", 12]]);
    expect(byNumber.get(12).locked).toBe(false);
    expect(out).toEqual([MOVED]);
  });

  it("stops waiting without locking when the head moves during the wait", () => {
    const { code, out, err, calls, sleeps, byNumber } = lockWith({
      env: EVENT_ENV,
      github: {
        open: [pullRequest(false)],
        polls: [[coderabbit("in_progress")]],
      },
      onSleep: (pullRequests) => {
        pullRequests.get(12).head = NEXT_HEAD;
      },
    });

    expect(code).toBe(0);
    expect(sleeps).toEqual([POLL_MS]);
    expect(calls).toEqual([
      ["pullRequest", 12],
      ["checkRuns", HEAD],
      ["pullRequest", 12],
    ]);
    expect(byNumber.get(12).locked).toBe(false);
    expect(out.at(-1)).toBe(MOVED);
    expect(err).toEqual([]);
  });

  it("keeps waiting and locks when the head stays the same during the wait", () => {
    const { code, calls } = event({
      open: [pullRequest(false)],
      polls: [
        [coderabbit("in_progress")],
        [coderabbit("completed", "success")],
      ],
    });

    expect(code).toBe(0);
    expect(named(calls, "checkRuns")).toHaveLength(2);
    expect(named(calls, "lock")).toEqual([12]);
  });

  it("locks and fails when the pull request cannot be read during the wait", () => {
    const { code, err, calls, byNumber } = event({
      open: [pullRequest(false)],
      polls: [[coderabbit("in_progress")]],
      readsBeforeFailure: 1,
    });

    expect(code).toBe(1);
    expect(named(calls, "checkRuns")).toHaveLength(1);
    expect(named(calls, "lock")).toEqual([12]);
    expect(byNumber.get(12).locked).toBe(true);
    expect(err).toEqual([
      "✗ HTTP 500: Internal Server Error",
      "✗ HTTP 500: Internal Server Error",
    ]);
  });
});

describe("pr:lock › the HEAD_SHA of the event", () => {
  it.each([
    [[], undefined],
    [[], ""],
    [[], "abc1234"],
    [[], HEAD.toUpperCase()],
    [["--lock-only"], "abc1234"],
    [["--lock-only"], HEAD.toUpperCase()],
    [["--lock-only"], `${HEAD}0`],
  ])(
    "refuses with %j a HEAD_SHA that is not the full sha of the head (%j)",
    (args, headSha) => {
      const { code, err, calls } = lockWith({
        args,
        env: { PR_NUMBER: "12", HEAD_SHA: headSha },
      });

      expect(code).toBe(2);
      expect(err).toEqual([
        `✗ HEAD_SHA must be the full sha of the head of the pull request, not "${headSha ?? ""}"`,
      ]);
      expect(calls).toEqual([]);
    },
  );

  it("needs no HEAD_SHA to lock every open pull request by hand", () => {
    const { code, calls } = lockWith({
      env: { PR_NUMBER: "" },
      github: { open: [{ number: 14, locked: false }] },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([["openPullRequests"], ["lock", 14]]);
  });
});

describe("pr:lock › the pull request of the event, failing closed", () => {
  it("locks and fails when the check runs of the head cannot be read", () => {
    const { code, err, calls, byNumber } = event({
      open: [pullRequest(false)],
      fails: ["checks"],
    });

    expect(code).toBe(1);
    expect(named(calls, "lock")).toEqual([12]);
    expect(byNumber.get(12).locked).toBe(true);
    expect(err).toEqual(["✗ HTTP 502: Bad Gateway"]);
  });

  it("still tries to lock and fails when the pull request cannot be read", () => {
    const { code, err, calls } = event({
      open: [pullRequest(false)],
      fails: ["read"],
    });

    expect(code).toBe(1);
    expect(named(calls, "checkRuns")).toEqual([]);
    expect(named(calls, "lock")).toEqual([12]);
    expect(err).toEqual(["✗ HTTP 404: Not Found", "✗ HTTP 404: Not Found"]);
  });

  it("fails with the error of GitHub when the lock fails after the review", () => {
    const { code, err, out, byNumber } = event({
      open: [pullRequest(false)],
      polls: [[coderabbit("completed", "success")]],
      fails: ["lock"],
    });

    expect(code).toBe(1);
    expect(byNumber.get(12).locked).toBe(false);
    expect(out).not.toContain("✓ #12 locked");
    expect(err).toEqual(["✗ HTTP 403: Resource not accessible by integration"]);
  });

  it("does not lock again a pull request someone locked during the wait", () => {
    const { github, calls, byNumber } = fakeGithub({
      open: [pullRequest(false)],
      polls: [
        [coderabbit("in_progress")],
        [coderabbit("completed", "success")],
      ],
    });
    const out = [];

    const code = run([], {
      env: EVENT_ENV,
      github,
      out: (line) => out.push(line),
      err: () => undefined,
      clock: () => 0,
      sleep: () => {
        byNumber.get(12).locked = true;
      },
    });

    expect(code).toBe(0);
    expect(named(calls, "lock")).toEqual([]);
    expect(out.at(-1)).toBe("- #12 is already locked");
  });

  it.each(["12a", "-1", "0", " 12"])(
    "refuses a PR_NUMBER that is not a pull request number (%j), without touching it",
    (number) => {
      const { code, err, calls } = lockWith({ env: { PR_NUMBER: number } });

      expect(code).toBe(1);
      expect(err).toEqual([
        `✗ PR_NUMBER must be the number of a pull request, not "${number}"`,
      ]);
      expect(calls).toEqual([]);
    },
  );
});

describe("pr:lock › every open pull request, by hand", () => {
  it("locks each open pull request that is not locked yet, when no PR_NUMBER comes", () => {
    const { code, out, calls, sleeps } = lockWith({
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
    expect(calls).toEqual([["openPullRequests"], ["lock", 14], ["lock", 7]]);
    expect(sleeps).toEqual([]);
    expect(out).toEqual([
      "✓ #14 locked",
      "- #9 is already locked",
      "✓ #7 locked",
    ]);
  });

  it("says so when there is no open pull request", () => {
    const { code, out, calls } = lockWith();

    expect(code).toBe(0);
    expect(calls).toEqual([["openPullRequests"]]);
    expect(out).toEqual(["- no open pull request"]);
  });

  it("reports the error of GitHub when an open pull request cannot be locked", () => {
    const { code, err } = lockWith({
      github: { open: [{ number: 14, locked: false }], fails: ["lock"] },
    });

    expect(code).toBe(1);
    expect(err).toEqual(["✗ HTTP 403: Resource not accessible by integration"]);
  });
});

const lockOnly = (options) =>
  lockWith({
    args: ["--lock-only"],
    env: EVENT_ENV,
    github: options,
  });

describe("pr:lock › lock only, after a cancelled or failed wait", () => {
  it("locks the pull request without waiting when it is not locked", () => {
    const { code, out, calls, sleeps } = lockOnly({
      open: [pullRequest(false)],
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      ["pullRequest", 12],
      ["lock", 12],
    ]);
    expect(sleeps).toEqual([]);
    expect(out).toEqual(["✓ #12 locked"]);
  });

  it("leaves the lock to the newer run when the head moved before the cleanup", () => {
    const { code, out, calls, byNumber } = lockOnly({
      open: [{ ...pullRequest(false), head: NEXT_HEAD }],
    });

    expect(code).toBe(0);
    expect(calls).toEqual([["pullRequest", 12]]);
    expect(byNumber.get(12).locked).toBe(false);
    expect(out).toEqual([MOVED]);
  });

  it("locks when GitHub returns the pull request without a head", () => {
    const { code, out, calls } = lockOnly({
      open: [{ number: 12, locked: false }],
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      ["pullRequest", 12],
      ["lock", 12],
    ]);
    expect(out).toEqual(["✓ #12 locked"]);
  });

  it("leaves a locked pull request as it is", () => {
    const { code, out, calls } = lockOnly({ open: [pullRequest(true)] });

    expect(code).toBe(0);
    expect(calls).toEqual([["pullRequest", 12]]);
    expect(out).toEqual(["- #12 is already locked"]);
  });

  it("still tries to lock and fails when the pull request cannot be read", () => {
    const { code, err, calls, byNumber } = lockOnly({
      open: [pullRequest(false)],
      fails: ["read"],
    });

    expect(code).toBe(1);
    expect(calls).toEqual([
      ["pullRequest", 12],
      ["lock", 12],
    ]);
    expect(byNumber.get(12).locked).toBe(true);
    expect(err).toEqual(["✗ HTTP 404: Not Found"]);
  });

  it("fails with the error of GitHub when the lock fails", () => {
    const { code, err, out, byNumber } = lockOnly({
      open: [pullRequest(false)],
      fails: ["lock"],
    });

    expect(code).toBe(1);
    expect(byNumber.get(12).locked).toBe(false);
    expect(out).toEqual([]);
    expect(err).toEqual(["✗ HTTP 403: Resource not accessible by integration"]);
  });

  it("refuses a PR_NUMBER that is not a pull request number, without touching it", () => {
    const { code, err, calls } = lockWith({
      args: ["--lock-only"],
      env: { PR_NUMBER: "12a" },
    });

    expect(code).toBe(1);
    expect(err).toEqual([
      '✗ PR_NUMBER must be the number of a pull request, not "12a"',
    ]);
    expect(calls).toEqual([]);
  });

  it("locks every open pull request when no PR_NUMBER comes", () => {
    const { code, calls } = lockWith({
      args: ["--lock-only"],
      github: { open: [{ number: 14, locked: false }] },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([["openPullRequests"], ["lock", 14]]);
  });
});

const lockByHand = (headSha, options) =>
  lockWith({
    args: ["--lock-only"],
    env: { PR_NUMBER: "12", HEAD_SHA: headSha },
    github: options,
  });

describe("pr:lock › lock only, one pull request by hand", () => {
  it.each([undefined, ""])(
    "locks the pull request of PR_NUMBER whatever its head when HEAD_SHA is %j",
    (headSha) => {
      const { code, out, err, calls, byNumber } = lockByHand(headSha, {
        open: [{ ...pullRequest(false), head: NEXT_HEAD }],
      });

      expect(code).toBe(0);
      expect(calls).toEqual([
        ["pullRequest", 12],
        ["lock", 12],
      ]);
      expect(byNumber.get(12).locked).toBe(true);
      expect(out).toEqual(["✓ #12 locked"]);
      expect(err).toEqual([]);
    },
  );

  it("leaves the pull request of PR_NUMBER as it is when it is already locked", () => {
    const { code, out, calls } = lockByHand(undefined, {
      open: [pullRequest(true)],
    });

    expect(code).toBe(0);
    expect(calls).toEqual([["pullRequest", 12]]);
    expect(out).toEqual(["- #12 is already locked"]);
  });

  it("fails with the error of GitHub when the lock by hand fails", () => {
    const { code, err, byNumber } = lockByHand(undefined, {
      open: [pullRequest(false)],
      fails: ["lock"],
    });

    expect(code).toBe(1);
    expect(byNumber.get(12).locked).toBe(false);
    expect(err).toEqual(["✗ HTTP 403: Resource not accessible by integration"]);
  });
});

function fakeGh(responses = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    return responses[args.at(-1)] ?? "";
  };

  return { gh, calls };
}

describe("pr:lock › the gh calls", () => {
  it("reads the pull request with its lock and the sha of its head", () => {
    const { gh, calls } = fakeGh({
      "repos/{owner}/{repo}/pulls/12": JSON.stringify({
        number: 12,
        locked: true,
        head: { sha: HEAD },
        title: "a title",
      }),
    });

    expect(githubFrom(gh).pullRequest(12)).toEqual(pullRequest(true));
    expect(calls).toEqual([["api", "repos/{owner}/{repo}/pulls/12"]]);
  });

  it("lists every page of the open pull requests", () => {
    const endpoint = "repos/{owner}/{repo}/pulls?state=open&per_page=100";
    const { gh, calls } = fakeGh({
      [endpoint]: JSON.stringify([
        [{ number: 14, locked: false, head: { sha: HEAD } }],
        [{ number: 9, locked: true, head: { sha: HEAD } }],
      ]),
    });

    expect(githubFrom(gh).openPullRequests()).toEqual([
      { number: 14, locked: false, head: HEAD },
      { number: 9, locked: true, head: HEAD },
    ]);
    expect(calls).toEqual([["api", "--paginate", "--slurp", endpoint]]);
  });

  it("reads only the CodeRabbit check runs of the head, with the slug of their app", () => {
    const endpoint = `repos/{owner}/{repo}/commits/${HEAD}/check-runs?check_name=CodeRabbit&per_page=100`;
    const { gh, calls } = fakeGh({
      [endpoint]: JSON.stringify({
        check_runs: [
          {
            id: 41,
            app: { slug: "coderabbitai" },
            status: "completed",
            conclusion: "skipped",
            started_at: "2026-01-01T00:00:00Z",
          },
          { id: 42, app: null, status: "queued", conclusion: null },
        ],
      }),
    });

    expect(githubFrom(gh).checkRuns(HEAD)).toEqual([
      coderabbit("completed", "skipped"),
      { app: undefined, status: "queued", conclusion: null },
    ]);
    expect(calls).toEqual([["api", endpoint]]);
  });

  it("locks through gh pr lock and has no way to unlock", () => {
    const { gh, calls } = fakeGh();
    const github = githubFrom(gh);

    github.lock(12);

    expect(calls).toEqual([["pr", "lock", "12"]]);
    expect(Object.keys(github).toSorted()).toEqual([
      "checkRuns",
      "lock",
      "openPullRequests",
      "pullRequest",
    ]);
  });
});

describe("pr:lock › run", () => {
  it.each([[["12"]], [["--lock-only", "12"]], [["--lock"]]])(
    "refuses any argument but --lock-only (%j), since the pull request comes in PR_NUMBER",
    (args) => {
      const { code, err, calls } = lockWith({ args });

      expect(code).toBe(2);
      expect(err).toEqual([
        "usage: npm run pr:lock [-- --lock-only] (every open pull request without PR_NUMBER; PR_NUMBER=<n> npm run pr:lock -- --lock-only locks just that one)",
      ]);
      expect(calls).toEqual([]);
    },
  );

  it("is the pr:lock npm script", () => {
    const { scripts } = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    );

    expect(scripts["pr:lock"]).toBe("node scripts/lock-pull-requests.mjs");
  });
});
