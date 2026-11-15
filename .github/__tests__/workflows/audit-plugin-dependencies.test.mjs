import { describe, expect, it } from "vitest";

import {
  describeWorkflowSecurity,
  stepNamed,
  stepUsing,
  triggers,
  workflow,
} from "../support/workflow.mjs";

const FILE = "audit-plugin-dependencies.yml";
const definition = workflow(FILE);
const audit = definition.jobs.audit;

describe("audit-plugin-dependencies.yml audits the dependencies of the telegram plugin, since Dependabot makes no security update for bun", () => {
  it("has the audit job only", () => {
    expect(Object.keys(definition.jobs)).toEqual(["audit"]);
  });

  it("runs every Monday, the weekly pace of Dependabot, and by hand", () => {
    expect(triggers(definition)).toEqual(["schedule", "workflow_dispatch"]);
    expect(definition.on.schedule).toEqual([{ cron: "0 8 * * 1" }]);
    expect(definition.on.workflow_dispatch ?? null).toBeNull();
  });

  it("runs one audit at a time, the newer one replacing the older", () => {
    expect(definition.concurrency).toEqual({
      group: "audit-plugin-dependencies",
      "cancel-in-progress": true,
    });
  });

  it("asks only to write issues, which opening and commenting the issue of an advisory needs", () => {
    expect(audit.permissions).toEqual({ contents: "read", issues: "write" });
    expect(JSON.stringify(audit)).not.toMatch(/secrets\./u);
  });

  it("gets bun from mise.lock and audits through audit:plugin:issue with the token of the run", () => {
    const step = stepNamed(audit, "Advisories of the plugin dependencies");

    expect(stepUsing(audit, "jdx/mise-action")).toBeDefined();
    expect(step.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      GH_REPO: "${{ github.repository }}",
    });
    expect(step.run).toBe("npm run --silent audit:plugin:issue");
    expect(audit.steps.at(-1)).toBe(step);
  });
});

describeWorkflowSecurity(FILE);
