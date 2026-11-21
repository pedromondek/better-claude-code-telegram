import { describe, expect, it } from "vitest";

import {
  describeWorkflowSecurity,
  stepNamed,
  stepUsing,
  triggers,
  workflow,
} from "../support/workflow.mjs";

const FILE = "lock-pull-requests.yml";
const definition = workflow(FILE);
const lock = definition.jobs.lock;

describe("lock-pull-requests.yml locks the conversation of every pull request, so only who has write access comments on it", () => {
  it("has the lock job only", () => {
    expect(Object.keys(definition.jobs)).toEqual(["lock"]);
  });

  it("runs apart from ci.yml when a pull request opens, and by hand to lock every open one", () => {
    expect(triggers(definition)).toEqual(["pull_request", "workflow_dispatch"]);
    expect(definition.on.pull_request).toEqual({ types: ["opened"] });
    expect(definition.on.workflow_dispatch ?? null).toBeNull();
  });

  it("runs one lock at a time per pull request, never cancelling one that started", () => {
    expect(definition.concurrency).toEqual({
      group:
        "lock-pull-requests-${{ github.event.pull_request.number || 'open' }}",
      "cancel-in-progress": false,
    });
  });

  it("skips a pull request from a fork, whose token is read-only, and leaves the dispatch to lock it", () => {
    expect(lock.if).toBe(
      "github.event_name == 'workflow_dispatch' || github.event.pull_request.head.repo.full_name == github.repository",
    );
  });

  it("asks only to write on pull requests, which the lock needs, and reads no secret", () => {
    expect(lock.permissions).toEqual({
      contents: "read",
      "pull-requests": "write",
    });
    expect(JSON.stringify(lock)).not.toMatch(/secrets\./u);
  });

  it("locks through pr:lock with the token of the run and the number of the event, empty by hand", () => {
    const step = stepNamed(lock, "Lock the conversation");

    expect(stepUsing(lock, "actions/setup-node").with).toEqual({
      "node-version-file": ".nvmrc",
    });
    expect(step.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      GH_REPO: "${{ github.repository }}",
      PR_NUMBER: "${{ github.event.pull_request.number }}",
    });
    expect(step.run).toBe("npm run --silent pr:lock");
    expect(lock.steps.at(-1)).toBe(step);
  });
});

describeWorkflowSecurity(FILE);
