import { describe, expect, it } from "vitest";

import {
  describeTaskContract,
  describeWorkflowSecurity,
  read,
  stepNamed,
  stepUsing,
  triggers,
  workflow,
} from "../support/workflow.mjs";

const FILE = "check-pull-request.yml";
const definition = workflow(FILE);
const pullRequest = definition.jobs["pull-request"];
const packageScripts = JSON.parse(read("package.json")).scripts;

describe("check-pull-request.yml checks the pull request title and its new dependencies, called by ci.yml", () => {
  it("has the pull-request job only", () => {
    expect(Object.keys(definition.jobs)).toEqual(["pull-request"]);
  });

  it("runs only when called, since it reads the pull request event, and is redone by re-running the pull request run", () => {
    expect(triggers(definition)).toEqual(["workflow_call"]);
    expect(definition.on.workflow_call ?? null).toBeNull();
  });

  it("runs on ubuntu with contents and pull-requests read only", () => {
    expect(pullRequest["runs-on"]).toMatch(/^ubuntu-/);
    expect(pullRequest.permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
    });
  });

  it("guards itself to pull requests, even when a caller forgets the condition", () => {
    expect(pullRequest.if).toBe("github.event_name == 'pull_request'");
  });

  it("checks the current title of the pull request, not the one of the event, so a re-run sees an edited title", () => {
    const title = stepNamed(
      pullRequest,
      "Title with the key of the branch issue",
    );

    expect(title.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      GH_REPO: "${{ github.repository }}",
      PR_NUMBER: "${{ github.event.pull_request.number }}",
    });
    expect(title.run).toBe('npm run --silent branch -- pr "$PR_NUMBER"');
    expect(packageScripts.branch).toBe("node scripts/branch.mjs");
  });

  it("sets up Node from the .nvmrc before the title check", () => {
    expect(
      stepUsing(pullRequest, "actions/setup-node").with["node-version-file"],
    ).toBe(".nvmrc");
  });

  it("fails on a new dependency with a high or critical vulnerability, the same cut as Dependabot", () => {
    expect(
      stepUsing(pullRequest, "actions/dependency-review-action").with,
    ).toEqual({ "fail-on-severity": "high" });
  });
});

describeWorkflowSecurity(FILE);
describeTaskContract(FILE);
