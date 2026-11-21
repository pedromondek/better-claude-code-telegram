import { describe, expect, it } from "vitest";

import {
  describeWorkflowSecurity,
  stepNamed,
  stepUsing,
  triggers,
  workflow,
} from "../support/workflow.mjs";

const FILE = "watch-upstream.yml";
const definition = workflow(FILE);
const watch = definition.jobs.watch;

describe("watch-upstream.yml opens an issue when the official Telegram plugin releases a new version", () => {
  it("has the watch job only", () => {
    expect(Object.keys(definition.jobs)).toEqual(["watch"]);
  });

  it("runs every 3 days of the month and by hand", () => {
    expect(triggers(definition)).toEqual(["schedule", "workflow_dispatch"]);
    expect(definition.on.schedule).toEqual([{ cron: "0 8 */3 * *" }]);
    expect(definition.on.workflow_dispatch ?? null).toBeNull();
  });

  it("runs one watch at a time, the newer one replacing the older", () => {
    expect(definition.concurrency).toEqual({
      group: "watch-upstream",
      "cancel-in-progress": true,
    });
  });

  it("asks only to write issues, which opening and commenting the issue of the new version needs", () => {
    expect(watch.permissions).toEqual({ contents: "read", issues: "write" });
    expect(JSON.stringify(watch)).not.toMatch(/secrets\./u);
  });

  it("watches through upstream:watch with the token of the run", () => {
    const step = stepNamed(watch, "New version of the official plugin");

    expect(stepUsing(watch, "actions/setup-node").with).toEqual({
      "node-version-file": ".nvmrc",
    });
    expect(step.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      GH_REPO: "${{ github.repository }}",
    });
    expect(step.run).toBe("npm run --silent upstream:watch");
    expect(watch.steps.at(-1)).toBe(step);
  });
});

describeWorkflowSecurity(FILE);
