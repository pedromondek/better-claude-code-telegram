import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AuditOrigin } from "../../../scripts/workflow-audit-issue.mjs";
import {
  ROOT,
  describeTaskContract,
  describeWorkflowSecurity,
  stepById,
  stepUsing,
  triggers,
  workflow,
} from "../support/workflow.mjs";

const FILE = "report-workflow-audit.yml";
const definition = workflow(FILE);
const job = definition.jobs.report;
const issue = stepById(job, "issue");
const packageScripts = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
).scripts;

describe("report-workflow-audit.yml opens or comments the issue of an online audit that failed on main", () => {
  it("is called with the origin, and dispatched by hand only to rehearse", () => {
    expect(triggers(definition)).toEqual([
      "workflow_call",
      "workflow_dispatch",
    ]);
    expect(definition.on.workflow_call.inputs).toEqual({
      origin: {
        description: expect.any(String),
        required: true,
        type: "string",
      },
    });
  });

  it("rehearses by hand: picks the origin from a select and opens nothing", () => {
    const { rehearsal } = definition.on.workflow_dispatch.inputs;

    expect(rehearsal.type).toBe("choice");
    expect(rehearsal.required).toBe(true);
    expect(rehearsal.options).toEqual(Object.values(AuditOrigin));
  });

  it("has one job, which reads the code and writes only issues", () => {
    expect(Object.keys(definition.jobs)).toEqual(["report"]);
    expect(job.permissions).toEqual({ contents: "read", issues: "write" });
  });

  it("reads the log that the audit of the same commit uploaded, without failing when there is none", () => {
    const download = stepUsing(job, "actions/download-artifact");

    expect(download["continue-on-error"]).toBe(true);
    expect(download.with).toEqual({
      name: "workflow-audit-${{ github.sha }}",
      path: "workflow-audit-artifacts",
    });
  });

  it("gives the token only to the issue step, which runs the tested script", () => {
    expect(issue.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      GH_REPO: "${{ github.repository }}",
      AUDIT_ORIGIN: "${{ inputs.origin || inputs.rehearsal }}",
      DRY_RUN: "${{ inputs.rehearsal != '' && '1' || '' }}",
      LOG_FILE: "workflow-audit-artifacts/workflow-audit.log",
    });
    expect(issue.run).toBe("npm run --silent audit:workflows:issue");
    expect(packageScripts["audit:workflows:issue"]).toBe(
      "node scripts/workflow-audit-issue.mjs",
    );

    for (const item of job.steps.filter((entry) => entry.id !== "issue")) {
      expect(JSON.stringify(item.env ?? {})).not.toMatch(
        /github\.token|secrets\./u,
      );
    }
  });
});

describeWorkflowSecurity(FILE);
describeTaskContract(FILE);
