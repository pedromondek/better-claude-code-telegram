import { describe, expect, it } from "vitest";

import {
  describeWorkflowSecurity,
  read,
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

  it("runs apart from ci.yml on each new head of a pull request, and by hand to lock every open one", () => {
    expect(triggers(definition)).toEqual(["pull_request", "workflow_dispatch"]);
    expect(definition.on.pull_request).toEqual({
      types: ["opened", "reopened", "synchronize"],
    });
    expect(definition.on.workflow_dispatch ?? null).toBeNull();
  });

  it("cancels the run still waiting on an older head, so the newest run locks at its end", () => {
    expect(definition.concurrency).toEqual({
      group:
        "lock-pull-requests-${{ github.event.pull_request.number || 'open' }}",
      "cancel-in-progress": true,
    });
  });

  it("gives the job room for the 20 minute wait on the CodeRabbit review", () => {
    expect(lock["timeout-minutes"]).toBe(25);
  });

  it("skips a pull request from a fork, whose token is read-only, and leaves the dispatch to lock it", () => {
    expect(lock.if).toBe(
      "github.event_name == 'workflow_dispatch' || github.event.pull_request.head.repo.full_name == github.repository",
    );
  });

  it("asks only to lock pull requests and to read check runs, and reads no secret", () => {
    expect(lock.permissions).toEqual({
      contents: "read",
      "pull-requests": "write",
      checks: "read",
    });
    expect(JSON.stringify(lock)).not.toMatch(/secrets\./u);
  });

  it("documents each permission beyond contents on its own line, as the job only waits and locks", () => {
    const lines = read(".github/workflows/lock-pull-requests.yml").split("\n");
    const comment = (scope) =>
      lines.find((line) => line.trim().startsWith(scope)) ?? "";

    expect(comment("checks: read")).toMatch(
      /# reads the CodeRabbit check to know when its review finished$/u,
    );
    expect(comment("pull-requests: write")).toMatch(/# gh pr lock /u);
    expect(comment("pull-requests: write")).not.toMatch(/unlock/u);
  });

  it("locks through pr:lock with the token, the number and the head of the event, empty by hand", () => {
    const step = stepNamed(
      lock,
      "Wait for CodeRabbit and lock the conversation",
    );

    expect(stepUsing(lock, "actions/setup-node").with).toEqual({
      "node-version-file": ".nvmrc",
    });
    expect(step.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      GH_REPO: "${{ github.repository }}",
      PR_NUMBER: "${{ github.event.pull_request.number }}",
      HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
    });
    expect(step.run).toBe("npm run --silent pr:lock");
    expect(lock.steps.at(-2)).toBe(step);
  });

  it("locks again through pr:lock --lock-only as the last step when the wait of an event is cancelled or fails", () => {
    const step = stepNamed(
      lock,
      "Lock the conversation after a cancelled or failed wait",
    );

    expect(lock.steps.at(-1)).toBe(step);
    expect(step.if).toBe(
      "(cancelled() || failure()) && github.event_name == 'pull_request'",
    );
    expect(step.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      GH_REPO: "${{ github.repository }}",
      PR_NUMBER: "${{ github.event.pull_request.number }}",
      HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
    });
    expect(step.run).toBe("npm run --silent pr:lock -- --lock-only");
  });
});

describeWorkflowSecurity(FILE);
