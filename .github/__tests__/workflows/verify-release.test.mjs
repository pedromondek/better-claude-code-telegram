import { describe, expect, it } from "vitest";

import { MERGED_PR_CHOICES } from "../../../scripts/merged-pr.mjs";
import {
  describeTaskContract,
  describeWorkflowSecurity,
  read,
  stepById,
  stepNamed,
  stepUsing,
  triggers,
  workflow,
} from "../support/workflow.mjs";

const FILE = "verify-release.yml";
const definition = workflow(FILE);
const verify = definition.jobs.verify;
const packageScripts = JSON.parse(read("package.json")).scripts;

describe("verify-release.yml checks the published Release and npm packages against checksums.txt of the record", () => {
  it("has the verify job only", () => {
    expect(Object.keys(definition.jobs)).toEqual(["verify"]);
  });

  it("is called by the release with the number of the version pull request, and hands back the record commit", () => {
    expect(triggers(definition)).toEqual([
      "workflow_call",
      "workflow_dispatch",
    ]);
    expect(definition.on.workflow_call.inputs).toEqual({
      pr_number: {
        description: expect.any(String),
        required: true,
        type: "string",
      },
    });
    expect(definition.on.workflow_call.outputs).toEqual({
      commit: {
        description: expect.any(String),
        value: "${{ jobs.verify.outputs.commit }}",
      },
    });
    expect(verify.outputs).toEqual({
      commit: "${{ steps.verify.outputs.commit }}",
    });
  });

  it("can be dispatched alone on a merged version pull request, through the select or its number", () => {
    expect(definition.on.workflow_dispatch.inputs).toEqual({
      pr: {
        description: expect.any(String),
        required: true,
        type: "choice",
        options: MERGED_PR_CHOICES,
      },
      pr_number: {
        description: expect.any(String),
        required: false,
        type: "string",
        default: "",
      },
    });
  });

  it("only reads the code and the attestations of the binaries", () => {
    expect(verify.permissions).toEqual({
      contents: "read",
      attestations: "read",
    });
    expect(verify.environment).toBeUndefined();
  });

  it("finds the pull request of a dispatch through merged-pr, from the history of main", () => {
    const target = stepById(verify, "target");

    expect(stepUsing(verify, "actions/checkout").with).toEqual({
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    expect(target.if).toBe("inputs.pr != ''");
    expect(target.env).toEqual({
      PR_CHOICE: "${{ inputs.pr }}",
      PR_NUMBER: "${{ inputs.pr_number }}",
    });
    expect(target.run).toBe("npm run --silent merged-pr");
  });

  it("verifies through release:verify with the GITHUB_TOKEN, and nothing else", () => {
    const step = stepById(verify, "verify");

    expect(step.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      GH_REPO: "${{ github.repository }}",
      PR_NUMBER: "${{ steps.target.outputs.number || inputs.pr_number }}",
    });
    expect(step.run).toBe("npm run --silent release:verify");
    expect(packageScripts["release:verify"]).toBe(
      "node scripts/release-verify.mjs",
    );
    expect(verify.steps.at(-1)).toBe(step);
    expect(JSON.stringify(verify)).not.toMatch(/secrets\./u);
  });

  it("runs on the Node of .nvmrc, whose npm audits the signatures", () => {
    expect(stepUsing(verify, "actions/setup-node").with).toEqual({
      "node-version-file": ".nvmrc",
    });
    expect(stepNamed(verify, "Release and npm packages of the record")).toBe(
      stepById(verify, "verify"),
    );
  });
});

describeTaskContract(FILE);
describeWorkflowSecurity(FILE);
