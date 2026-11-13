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
const prepare = definition.jobs.prepare;
const packageScripts = JSON.parse(read("package.json")).scripts;

describe("prepare-release.yml opens the version pull request by hand, with the app token", () => {
  it("has the prepare job only", () => {
    expect(Object.keys(definition.jobs)).toEqual(["prepare"]);
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

  it("prepares only from main", () => {
    expect(prepare.if).toBe("github.ref == 'refs/heads/main'");
  });

  it("checks out the whole history, which git-cliff reads for the bump and the draft", () => {
    expect(stepUsing(prepare, "actions/checkout").with).toEqual({
      "fetch-depth": 0,
      "persist-credentials": false,
    });
  });

  it("installs git-cliff from mise.lock and Node from the .nvmrc", () => {
    expect(stepUsing(prepare, "jdx/mise-action").with.version).toMatch(
      /^\d{4}\.\d+\.\d+$/u,
    );
    expect(
      stepUsing(prepare, "actions/setup-node").with["node-version-file"],
    ).toBe(".nvmrc");
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

  it("hands the token only to the last step, which prepares the exact version or else the stage through the release:pr script", () => {
    const steps = prepare.steps;
    const last = stepNamed(prepare, "Version files, branch and pull request");

    expect(steps.at(-1)).toBe(last);
    expect(last.env).toEqual({
      GH_TOKEN: "${{ steps.app.outputs.token }}",
      GH_REPO: "${{ github.repository }}",
      STAGE: "${{ inputs.stage }}",
      VERSION: "${{ inputs.version }}",
    });
    expect(last.run).toBe(
      'npm run --silent release:pr -- prepare "${VERSION:-$STAGE}"',
    );
    expect(packageScripts["release:pr"]).toBe("node scripts/release-pr.mjs");
    for (const step of steps.slice(0, -1)) {
      expect(JSON.stringify(step)).not.toContain("steps.app.outputs.token");
    }
  });
});

describeWorkflowSecurity(FILE);
