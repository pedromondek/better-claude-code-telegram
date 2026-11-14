import { describe, expect, it } from "vitest";

import {
  describeWorkflowSecurity,
  read,
  stepNamed,
  stepUsing,
  triggers,
  workflow,
} from "../support/workflow.mjs";

const FILE = "prepare-release.yml";
const definition = workflow(FILE);
const { plan, approval, prepare } = definition.jobs;
const packageScripts = JSON.parse(read("package.json")).scripts;

describe("prepare-release.yml computes the next version, waits for approval on a minor or major and opens the version pull request", () => {
  it("has the plan, approval and prepare jobs, in this order of needs", () => {
    expect(Object.keys(definition.jobs)).toEqual([
      "plan",
      "approval",
      "prepare",
    ]);
    expect(approval.needs).toBe("plan");
    expect(prepare.needs).toEqual(["plan", "approval"]);
  });

  it("runs only by hand, picking the stage in a select or typing an exact version", () => {
    expect(triggers(definition)).toEqual(["workflow_dispatch"]);
    expect(definition.on.workflow_dispatch.inputs).toEqual({
      stage: {
        description: expect.any(String),
        required: true,
        type: "choice",
        options: ["alpha", "beta", "rc", "stable"],
      },
      version: {
        description: expect.any(String),
        required: false,
        type: "string",
        default: "",
      },
    });
  });

  it("prepares one version at a time and never cancels a run that may have opened the branch", () => {
    expect(definition.concurrency).toEqual({
      group: "prepare-release",
      "cancel-in-progress": false,
    });
  });

  it("plans only from main", () => {
    expect(plan.if).toBe("github.ref == 'refs/heads/main'");
  });

  it("plans with the whole history, git-cliff from mise.lock and the read-only token of the run, handing the version and the approval to the next jobs", () => {
    expect(stepUsing(plan, "actions/checkout").with).toEqual({
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    expect(stepUsing(plan, "jdx/mise-action").with.version).toMatch(
      /^\d{4}\.\d+\.\d+$/u,
    );

    const step = stepNamed(
      plan,
      "Next version, checked against every version released",
    );

    expect(step.id).toBe("plan");
    expect(step.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      GH_REPO: "${{ github.repository }}",
      STAGE: "${{ inputs.stage }}",
      VERSION: "${{ inputs.version }}",
    });
    expect(step.run).toBe(
      'npm run --silent release:pr -- plan "${VERSION:-$STAGE}"',
    );
    expect(plan.outputs).toEqual({
      version: "${{ steps.plan.outputs.version }}",
      approval: "${{ steps.plan.outputs.approval }}",
    });
    expect(packageScripts["release:pr"]).toBe("node scripts/release-pr.mjs");
  });

  it("asks for approval in the release-approval environment only when the plan says so, without any token", () => {
    expect(approval.if).toBe("needs.plan.outputs.approval == 'true'");
    expect(approval.environment).toBe("release-approval");
    expect(JSON.stringify(approval)).not.toMatch(/secrets\.|token/u);
  });

  it("opens the pull request only when no approval is needed or the approval succeeded, never after a rejection, a cancel or a failed plan", () => {
    expect(prepare.if).toBe(
      "always() && needs.plan.result == 'success' && (needs.plan.outputs.approval == 'false' || needs.approval.result == 'success')",
    );
  });

  it("takes the release app token with only contents and pull requests, since a pull request opened with GITHUB_TOKEN starts no CI", () => {
    const token = stepUsing(prepare, "actions/create-github-app-token");

    expect(token.id).toBe("app");
    expect(token.with).toEqual({
      "client-id": "${{ vars.RELEASE_APP_CLIENT_ID }}",
      "private-key": "${{ secrets.RELEASE_APP_PRIVATE_KEY }}",
      "permission-contents": "write",
      "permission-pull-requests": "write",
    });
  });

  it("hands the token only to the last step, which prepares the planned version and checks it again", () => {
    const last = stepNamed(prepare, "Version files, branch and pull request");

    expect(prepare.steps.at(-1)).toBe(last);
    expect(last.env).toEqual({
      GH_TOKEN: "${{ steps.app.outputs.token }}",
      GH_REPO: "${{ github.repository }}",
      VERSION: "${{ needs.plan.outputs.version }}",
    });
    expect(last.run).toBe('npm run --silent release:pr -- prepare "$VERSION"');
    for (const step of prepare.steps.slice(0, -1)) {
      expect(JSON.stringify(step)).not.toContain("steps.app.outputs.token");
    }
  });
});

describeWorkflowSecurity(FILE);
