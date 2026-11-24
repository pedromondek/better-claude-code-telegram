import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { run } from "../ci-passed.mjs";

const ENV = { GH_REPO: "owner/repo", RUN_ID: "45423614888" };

const job = (name, status, conclusion) => ({ name, status, conclusion });

const RUN_WITH_CANCELLED_LEG = [
  job("Checks / Checks (the same as the pre-push)", "completed", "success"),
  job("Checks / Merged pull request", "completed", "skipped"),
  job("Rust / Rust on macos-15", "completed", "cancelled"),
  job("Rust / Rust on windows-2025", "completed", "success"),
  job("Mutation / Stryker mutation", "completed", "success"),
  job("Pull request", "completed", "skipped"),
  job("CI passed", "in_progress", null),
];

function fakeGh(pages) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);

    if (pages instanceof Error) throw pages;

    return JSON.stringify(
      pages.map((jobs) => ({ total_count: jobs.length, jobs })),
    );
  };

  return { gh, calls };
}

function runWith(pages, env = ENV) {
  const { gh, calls } = fakeGh(pages);
  const out = [];
  const err = [];
  const code = run({
    env,
    gh,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

  return { code, out: out.join("\n"), err: err.join("\n"), calls };
}

describe("ci-passed › verdict", () => {
  it("passes when every finished job passed or was skipped", () => {
    const { code, out } = runWith([
      RUN_WITH_CANCELLED_LEG.filter(
        ({ conclusion }) => conclusion !== "cancelled",
      ),
    ]);

    expect(code).toBe(0);
    expect(out).toBe("✓ Every finished job of the run passed or was skipped.");
  });

  it("fails on the cancelled leg of a called task that its caller reported as passing", () => {
    const { code, err } = runWith([RUN_WITH_CANCELLED_LEG]);

    expect(code).toBe(1);
    expect(err).toBe(
      [
        "✗ 1 job of the run did not pass:",
        "  - Rust / Rust on macos-15: cancelled",
      ].join("\n"),
    );
  });

  it("lists every failed and timed out job by name and conclusion", () => {
    const { code, err } = runWith([
      [
        job(
          "Checks / Checks (the same as the pre-push)",
          "completed",
          "failure",
        ),
        job("Mutation / Rust mutation · shard 3", "completed", "timed_out"),
        job("Rust / Rust on windows-2025", "completed", "success"),
      ],
    ]);

    expect(code).toBe(1);
    expect(err).toBe(
      [
        "✗ 2 jobs of the run did not pass:",
        "  - Checks / Checks (the same as the pre-push): failure",
        "  - Mutation / Rust mutation · shard 3: timed_out",
      ].join("\n"),
    );
  });

  it("leaves out the CI passed job itself, even from an earlier failed attempt", () => {
    const { code } = runWith([[job("CI passed", "completed", "failure")]]);

    expect(code).toBe(0);
  });

  it.each(["queued", "in_progress", "waiting", "pending"])(
    "ignores a job still %s, which has no conclusion yet",
    (status) => {
      const { code } = runWith([
        [job("Issue of the online audit", status, "cancelled")],
      ]);

      expect(code).toBe(0);
    },
  );

  it.each(["skipped", "neutral", "success"])(
    "passes a finished job whose conclusion is %s",
    (conclusion) => {
      const { code } = runWith([
        [job("Pull request", "completed", conclusion)],
      ]);

      expect(code).toBe(0);
    },
  );

  it("reads every page of the latest attempt of each job", () => {
    const { code, err, calls } = runWith([
      [
        job(
          "Checks / Checks (the same as the pre-push)",
          "completed",
          "success",
        ),
      ],
      [job("Rust / Rust on macos-15", "completed", "cancelled")],
    ]);

    expect(code).toBe(1);
    expect(err).toContain("Rust / Rust on macos-15: cancelled");
    expect(calls).toEqual([
      [
        "api",
        "--paginate",
        "--slurp",
        "repos/owner/repo/actions/runs/45423614888/jobs?filter=latest&per_page=100",
      ],
    ]);
  });

  it("passes a run whose pages carry no job", () => {
    expect(runWith([]).code).toBe(0);
  });
});

describe("ci-passed › errors", () => {
  it("fails with the gh error when the jobs cannot be read", () => {
    const { code, err } = runWith(
      new Error("HTTP 403: Resource not accessible by integration"),
    );

    expect(code).toBe(1);
    expect(err).toBe("✗ HTTP 403: Resource not accessible by integration");
  });

  it.each([undefined, "", "12/merge", "0", "-1"])(
    "fails without calling gh when RUN_ID is %j",
    (runId) => {
      const { code, err, calls } = runWith([], { ...ENV, RUN_ID: runId });

      expect(code).toBe(1);
      expect(err).toBe(
        `✗ RUN_ID must be the id of a workflow run, not "${runId ?? ""}"`,
      );
      expect(calls).toEqual([]);
    },
  );

  it.each([undefined, "", "owner", "owner/repo/extra", "owner/re po"])(
    "fails without calling gh when GH_REPO is %j",
    (repo) => {
      const { code, err, calls } = runWith([], { ...ENV, GH_REPO: repo });

      expect(code).toBe(1);
      expect(err).toBe(
        `✗ GH_REPO must name the repository as owner/name, not "${repo ?? ""}"`,
      );
      expect(calls).toEqual([]);
    },
  );
});

describe("ci-passed › package script", () => {
  it("runs through npm run ci:passed", () => {
    const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));

    expect(scripts["ci:passed"]).toBe("node scripts/ci-passed.mjs");
  });
});
