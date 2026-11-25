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

const NO_RUNNER = JSON.parse(
  readFileSync(
    new URL("fixtures/no-runner-jobs.json", import.meta.url),
    "utf8",
  ),
);

const [NO_RUNNER_JOB, OTHER_NO_RUNNER_JOB] = NO_RUNNER.jobs;

const ANNOTATIONS_PATH = /^repos\/owner\/repo\/check-runs\/(\d+)\/annotations/u;

function annotationsCall(jobId) {
  return [
    "api",
    "--paginate",
    "--slurp",
    `repos/owner/repo/check-runs/${jobId}/annotations?per_page=100`,
  ];
}

function fakeGh(pages, annotations) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);

    const jobId = ANNOTATIONS_PATH.exec(args.at(-1))?.[1];

    if (jobId !== undefined) {
      const reply = annotations[jobId];

      if (reply instanceof Error || typeof reply === "string") throw reply;

      return JSON.stringify(reply);
    }

    if (pages instanceof Error) throw pages;

    return JSON.stringify(
      pages.map((jobs) => ({ total_count: jobs.length, jobs })),
    );
  };

  return { gh, calls };
}

function runWith(pages, env = ENV, annotations = {}) {
  const { gh, calls } = fakeGh(pages, annotations);
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

describe("ci-passed › job that got no runner", () => {
  const WARNING = (name) => `::warning::${name} got no runner and did not run.`;
  const PASSED = "✓ Every finished job of the run passed or was skipped.";
  const SUCCESS = job("Rust / Rust on windows-2025", "completed", "success");
  const NOTICES = NO_RUNNER.annotations.filter(
    ({ annotation_level }) => annotation_level === "notice",
  );

  it.each(NO_RUNNER.jobs.map(({ id }) => id))(
    "passes with a warning naming the job when job %s got no runner",
    (jobId) => {
      const noRunnerJob = NO_RUNNER.jobs.find(({ id }) => id === jobId);
      const { code, out, err, calls } = runWith([[SUCCESS, noRunnerJob]], ENV, {
        [jobId]: [NO_RUNNER.annotations],
      });

      expect(code).toBe(0);
      expect(out).toBe([WARNING("Rust / Rust on macos-15"), PASSED].join("\n"));
      expect(err).toBe("");
      expect(calls.slice(1)).toEqual([annotationsCall(jobId)]);
    },
  );

  it("passes with one warning per job when every failed job got no runner", () => {
    const intel = {
      ...OTHER_NO_RUNNER_JOB,
      name: "Rust / Rust on macos-15-intel",
    };
    const { code, out } = runWith([[NO_RUNNER_JOB, intel]], ENV, {
      [NO_RUNNER_JOB.id]: [NO_RUNNER.annotations],
      [intel.id]: [NO_RUNNER.annotations],
    });

    expect(code).toBe(0);
    expect(out).toBe(
      [
        WARNING("Rust / Rust on macos-15"),
        WARNING("Rust / Rust on macos-15-intel"),
        PASSED,
      ].join("\n"),
    );
  });

  it("finds the no runner annotation on a later page of the annotations", () => {
    const { code } = runWith([[NO_RUNNER_JOB]], ENV, {
      [NO_RUNNER_JOB.id]: [NOTICES, NO_RUNNER.annotations.slice(0, 1)],
    });

    expect(code).toBe(0);
  });

  it("fails on a real failure next to a job that got no runner, warning for the latter", () => {
    const { code, out, err } = runWith(
      [[NO_RUNNER_JOB, job("Checks / Checks", "completed", "failure")]],
      ENV,
      { [NO_RUNNER_JOB.id]: [NO_RUNNER.annotations] },
    );

    expect(code).toBe(1);
    expect(out).toBe(WARNING("Rust / Rust on macos-15"));
    expect(err).toBe(
      ["✗ 1 job of the run did not pass:", "  - Checks / Checks: failure"].join(
        "\n",
      ),
    );
  });

  it.each([
    ["steps", { steps: [{ name: "Set up job", conclusion: "cancelled" }] }],
    ["no steps field", { steps: undefined }],
    ["a runner_id", { runner_id: 12 }],
    ["no runner_id field", { runner_id: undefined }],
    ["conclusion failure", { conclusion: "failure" }],
    ["conclusion timed_out", { conclusion: "timed_out" }],
  ])(
    "fails without reading the annotations when the job has %s",
    (_, change) => {
      const changed = { ...NO_RUNNER_JOB, ...change };
      const { code, out, err, calls } = runWith([[changed]], ENV, {
        [NO_RUNNER_JOB.id]: [NO_RUNNER.annotations],
      });

      expect(code).toBe(1);
      expect(out).toBe("");
      expect(err).toBe(
        [
          "✗ 1 job of the run did not pass:",
          `  - Rust / Rust on macos-15: ${changed.conclusion}`,
        ].join("\n"),
      );
      expect(calls).toHaveLength(1);
    },
  );

  it.each([
    [
      "another failure message",
      [
        [
          {
            annotation_level: "failure",
            message: "The operation was canceled.",
          },
        ],
      ],
    ],
    ["only the capacity notices", [NOTICES]],
    [
      "the no runner message only at notice level",
      [[{ ...NO_RUNNER.annotations[0], annotation_level: "notice" }]],
    ],
    ["no annotation", [[]]],
    ["no page", []],
  ])("fails when the annotations of the job hold %s", (_, pages) => {
    const { code, out, err, calls } = runWith([[NO_RUNNER_JOB]], ENV, {
      [NO_RUNNER_JOB.id]: pages,
    });

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe(
      [
        "✗ 1 job of the run did not pass:",
        "  - Rust / Rust on macos-15: cancelled",
      ].join("\n"),
    );
    expect(calls.slice(1)).toEqual([annotationsCall(NO_RUNNER_JOB.id)]);
  });

  it.each([
    ["an Error", new Error("HTTP 403: Resource not accessible by integration")],
    ["a string", "HTTP 403: Resource not accessible by integration"],
  ])(
    "fails naming the job when reading its annotations throws %s",
    (_, failure) => {
      const { code, out, err } = runWith([[NO_RUNNER_JOB]], ENV, {
        [NO_RUNNER_JOB.id]: failure,
      });

      expect(code).toBe(1);
      expect(out).toBe("");
      expect(err).toBe(
        [
          "✗ Could not read the annotations of Rust / Rust on macos-15: HTTP 403: Resource not accessible by integration",
          "✗ 1 job of the run did not pass:",
          "  - Rust / Rust on macos-15: cancelled",
        ].join("\n"),
      );
    },
  );

  it("reads no annotation on a run whose jobs all ran on a runner", () => {
    const ran = {
      id: 138758970701,
      name: "Rust / Rust on macos-15",
      status: "completed",
      conclusion: "cancelled",
      steps: [{ name: "Set up job", conclusion: "success" }],
      runner_id: 1000123,
    };
    const { code, calls } = runWith([[SUCCESS, ran]]);

    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
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
