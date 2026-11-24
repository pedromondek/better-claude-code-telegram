import { describe, expect, it } from "vitest";

import {
  describeWorkflowSecurity,
  read,
  stepNamed,
  stepUsing,
  triggers,
  workflow,
} from "../support/workflow.mjs";

const FILE = "check-pull-request-notes.yml";
const definition = workflow(FILE);
const notes = definition.jobs["patch-notes"];
const packageScripts = JSON.parse(read("package.json")).scripts;
const PR_NUMBER = "${{ github.event.pull_request.number || inputs.pr_number }}";

describe("check-pull-request-notes.yml keeps a pull request red while its description lacks the patch notes", () => {
  it("has the patch-notes job only, named as the check the branch protection requires", () => {
    expect(Object.keys(definition.jobs)).toEqual(["patch-notes"]);
    expect(definition.name).toBe("Pull request notes");
    expect(notes.name).toBe("Patch notes");
  });

  it("runs apart from ci.yml when a pull request to main opens, reopens, is edited or gets a push, and by hand", () => {
    expect(triggers(definition)).toEqual(["pull_request", "workflow_dispatch"]);
    expect(definition.on.pull_request).toEqual({
      branches: ["main"],
      types: ["opened", "reopened", "edited", "synchronize"],
    });
  });

  it("takes the number of the pull request to check when dispatched by hand", () => {
    expect(definition.on.workflow_dispatch.inputs).toEqual({
      pr_number: {
        description: "Pull request (number) whose patch notes to check",
        required: true,
        type: "string",
      },
    });
  });

  it("is never called by ci.yml, so it stays out of the CI passed check", () => {
    expect(read(".github/workflows/ci.yml")).not.toContain(FILE);
  });

  it("cancels the run that a later edit supersedes, one group per pull request", () => {
    expect(definition.concurrency).toEqual({
      group: `check-pull-request-notes-${PR_NUMBER}`,
      "cancel-in-progress": true,
    });
  });

  it("checks every event of a pull request, from a fork too, so no skipped run stands in for a failed one", () => {
    expect(notes.if).toBeUndefined();
  });

  it("runs on ubuntu with contents and pull-requests read only", () => {
    expect(notes["runs-on"]).toMatch(/^ubuntu-/);
    expect(notes.permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
    });
  });

  it("sets up Node from the .nvmrc", () => {
    expect(
      stepUsing(notes, "actions/setup-node").with["node-version-file"],
    ).toBe(".nvmrc");
  });

  it("reads the current description through gh with the pr:patch-notes script, with the number through env", () => {
    const check = stepNamed(notes, "Patch notes in the description");

    expect(check.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      GH_REPO: "${{ github.repository }}",
      PR_NUMBER,
    });
    expect(check.run).toBe(
      'npm run --silent pr:patch-notes -- check "$PR_NUMBER"',
    );
    expect(packageScripts["pr:patch-notes"]).toBe(
      "node scripts/patch-notes.mjs",
    );
  });
});

describeWorkflowSecurity(FILE);
