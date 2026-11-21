import { describe, expect, it } from "vitest";

import {
  LOCAL_WORKFLOW,
  describeWorkflowSecurity,
  stepNamed,
  triggers,
  workflow,
} from "../support/workflow.mjs";

const FILE = "manage-ci-cache.yml";
const definition = workflow(FILE);
const { delete: remove, checks, rust, mutation } = definition.jobs;
const WARM = {
  checks: "push-checks.yml",
  rust: "check-rust-platforms.yml",
  mutation: "check-mutation.yml",
};

describe("manage-ci-cache.yml deletes the cache of a closed pull request and keeps the cache of main warm", () => {
  it("has the delete job and one warm job per task that keeps a cache", () => {
    expect(Object.keys(definition.jobs)).toEqual([
      "delete",
      ...Object.keys(WARM),
    ]);
  });

  it("runs when a pull request closes, every Monday and by hand", () => {
    expect(triggers(definition)).toEqual([
      "pull_request",
      "schedule",
      "workflow_dispatch",
    ]);
    expect(definition.on.pull_request).toEqual({ types: ["closed"] });
    expect(definition.on.schedule).toEqual([{ cron: "0 10 * * 1" }]);
  });

  it("runs one at a time per pull request or ref, never cancelling one that started", () => {
    expect(definition.concurrency).toEqual({
      group:
        "manage-ci-cache-${{ github.event.pull_request.number || github.ref }}",
      "cancel-in-progress": false,
    });
  });

  it("deletes only on a closed pull request of the repository, whose token can write", () => {
    expect(remove.if).toBe(
      "github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(remove.permissions).toEqual({
      contents: "read",
      actions: "write",
    });
  });

  it("deletes through ci:cache:delete with the token of the run and the number of the pull request", () => {
    const step = stepNamed(remove, "Delete the caches of the pull request");

    expect(step.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      GH_REPO: "${{ github.repository }}",
      PR_NUMBER: "${{ github.event.pull_request.number }}",
    });
    expect(step.run).toBe("npm run --silent ci:cache:delete");
    expect(remove.steps.at(-1)).toBe(step);
  });

  it.each(Object.entries(WARM))(
    "warms %s by calling %s outside the pull request events, which restores the cache of main and saves what is missing",
    (id, file) => {
      const job = definition.jobs[id];

      expect(job.uses).toBe(`${LOCAL_WORKFLOW}${file}`);
      expect(job.if).toBe("github.event_name != 'pull_request'");
      expect(job.permissions).toEqual({ contents: "read" });
    },
  );

  it("passes no input to the warm calls, so each task takes the range of the event", () => {
    for (const job of [checks, rust, mutation]) {
      expect(job.with).toBeUndefined();
    }
  });
});

describeWorkflowSecurity(FILE);
