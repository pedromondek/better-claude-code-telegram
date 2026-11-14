import { describe, expect, it } from "vitest";

import { AuditOrigin } from "../../../scripts/workflow-audit-issue.mjs";
import {
  LOCAL_WORKFLOW,
  describeWorkflowSecurity,
  triggers,
  workflow,
} from "../support/workflow.mjs";

const FILE = "audit-workflows-on-schedule.yml";
const definition = workflow(FILE);
const { audit, issue } = definition.jobs;

describe("audit-workflows-on-schedule.yml audits main every week, since the advisories change without a commit", () => {
  it("runs on Monday morning and by hand", () => {
    expect(triggers(definition)).toEqual(["schedule", "workflow_dispatch"]);
    expect(definition.on.schedule).toEqual([{ cron: "0 7 * * 1" }]);
  });

  it("keeps a single weekly run going at a time", () => {
    expect(definition.concurrency).toEqual({
      group: "audit-workflows-on-schedule",
      "cancel-in-progress": true,
    });
  });

  it("audits the whole of main through the task, forced, with read-only issues", () => {
    expect(audit.uses).toBe(`${LOCAL_WORKFLOW}audit-workflows.yml`);
    expect(audit.with).toEqual({ force: true });
    expect(audit.permissions).toEqual({ contents: "read", issues: "read" });
  });

  it("opens or comments the issue only when the audit failed", () => {
    expect(issue.needs).toEqual(["audit"]);
    expect(issue.if).toBe("always() && needs.audit.result == 'failure'");
    expect(issue.uses).toBe(`${LOCAL_WORKFLOW}report-workflow-audit.yml`);
    expect(issue.with).toEqual({ origin: AuditOrigin.WEEKLY });
    expect(issue.permissions).toEqual({ contents: "read", issues: "write" });
  });

  it("has only these two jobs", () => {
    expect(Object.keys(definition.jobs)).toEqual(["audit", "issue"]);
  });
});

describeWorkflowSecurity(FILE);
