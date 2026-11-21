import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ROOT,
  describeTaskContract,
  describeWorkflowSecurity,
  stepById,
  stepNamed,
  stepUsing,
  triggers,
  workflow,
} from "../support/workflow.mjs";

const FILE = "audit-workflows.yml";
const definition = workflow(FILE);
const job = definition.jobs.audit;
const audit = stepById(job, "audit");
const packageScripts = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
).scripts;

describe("audit-workflows.yml runs zizmor and pinact online, with a read-only token", () => {
  it("is called by the CI and by the weekly entry, and can be dispatched alone, which audits everything", () => {
    expect(triggers(definition)).toEqual([
      "workflow_call",
      "workflow_dispatch",
    ]);
  });

  it("takes the commit, the range and whether the audit is forced, all optional", () => {
    const { inputs } = definition.on.workflow_call;

    expect(Object.keys(inputs)).toEqual(["ref", "before", "force"]);
    expect(
      Object.values(inputs).map((input) => [input.type, input.required]),
    ).toEqual([
      ["string", false],
      ["string", false],
      ["boolean", false],
    ]);
    expect(inputs.force.default).toBe(false);
  });

  it("returns whether it ran and its exit code", () => {
    const { outputs } = definition.on.workflow_call;

    expect(outputs.ran.value).toBe("${{ jobs.audit.outputs.ran }}");
    expect(outputs.exit.value).toBe("${{ jobs.audit.outputs.exit }}");
    expect(job.outputs).toEqual({
      ran: "${{ steps.audit.outputs.ran }}",
      exit: "${{ steps.audit.outputs.exit }}",
    });
  });

  it("has one job, which only reads the code and the issues (the link of the open issue of an inherited finding)", () => {
    expect(Object.keys(definition.jobs)).toEqual(["audit"]);
    expect(job.permissions).toEqual({ contents: "read", issues: "read" });
  });

  it("checks out the requested commit with its history, for the range, without the credential on disk", () => {
    expect(stepUsing(job, "actions/checkout").with).toEqual({
      ref: "${{ inputs.ref }}",
      "fetch-depth": 0,
      "persist-credentials": false,
    });
  });

  it("installs zizmor and pinact through the same mise step as the checks", () => {
    const checksMise = stepNamed(
      workflow("push-checks.yml").jobs.checks,
      "Tools of mise.lock",
    );
    const mise = stepNamed(job, "Tools of mise.lock");

    expect(mise.uses).toBe(checksMise.uses);
    expect(mise.with).toEqual(checksMise.with);
  });

  it("gives the token only to the audit step, by the names each tool reads, and runs the tested script", () => {
    expect(audit.env).toEqual({
      BEFORE: "${{ inputs.before }}",
      FORCE: "${{ inputs.force || github.event_name == 'workflow_dispatch' }}",
      LOG_FILE: "workflow-audit.log",
      GH_TOKEN: "${{ github.token }}",
      GH_REPO: "${{ github.repository }}",
      ZIZMOR_GITHUB_TOKEN: "${{ github.token }}",
      PINACT_GITHUB_TOKEN: "${{ github.token }}",
    });
    expect(audit.run).toBe("npm run --silent audit:workflows");
    expect(packageScripts["audit:workflows"]).toBe(
      "node scripts/workflow-audit.mjs",
    );

    for (const item of job.steps.filter((entry) => entry.id !== "audit")) {
      expect(JSON.stringify(item.env ?? {})).not.toMatch(
        /github\.token|secrets\./u,
      );
    }
  });

  it("uploads the audit log under the commit, for the issue to read", () => {
    const report = stepUsing(job, "actions/upload-artifact");

    expect(report.if).toBe("always()");
    expect(report.with).toEqual({
      name: "workflow-audit-${{ inputs.ref || github.sha }}",
      path: "workflow-audit.log",
      "if-no-files-found": "ignore",
      "retention-days": 30,
    });
  });
});

describeWorkflowSecurity(FILE);
describeTaskContract(FILE);
