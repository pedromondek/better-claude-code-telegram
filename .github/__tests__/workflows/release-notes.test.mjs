import { describe, expect, it } from "vitest";

import {
  describeWorkflowSecurity,
  read,
  stepNamed,
  stepUsing,
  triggers,
  workflow,
} from "../support/workflow.mjs";

const FILE = "release-notes.yml";
const definition = workflow(FILE);
const notes = definition.jobs["release-notes"];
const packageScripts = JSON.parse(read("package.json")).scripts;

describe("release-notes.yml keeps the version pull request red until its notes replace the git-cliff draft", () => {
  it("has the release-notes job only, named as the check the description of the version pull request cites", () => {
    expect(Object.keys(definition.jobs)).toEqual(["release-notes"]);
    expect(notes.name).toBe("Release notes");
  });

  it("runs apart from ci.yml, on every edit of the description and on every push, so the check is on the head commit and an edit never cancels the CI", () => {
    expect(triggers(definition)).toEqual(["pull_request"]);
    expect(definition.on.pull_request).toEqual({
      types: ["opened", "edited", "reopened", "synchronize"],
    });
  });

  it("cancels the run that an edit or a push supersedes, one group per pull request", () => {
    expect(definition.concurrency).toEqual({
      group: "release-notes-${{ github.event.pull_request.number }}",
      "cancel-in-progress": true,
    });
  });

  it("checks only the version branches, and is skipped, which passes, on every other pull request", () => {
    expect(notes.if).toBe("startsWith(github.head_ref, 'release/v')");
  });

  it("sets up Node from the .nvmrc", () => {
    expect(
      stepUsing(notes, "actions/setup-node").with["node-version-file"],
    ).toBe(".nvmrc");
  });

  it("reads the description through env with the release:pr script", () => {
    const check = stepNamed(notes, "Notes written in the description");

    expect(check.env).toEqual({
      PR_BODY: "${{ github.event.pull_request.body }}",
    });
    expect(check.run).toBe("npm run --silent release:pr -- check-notes");
    expect(packageScripts["release:pr"]).toBe("node scripts/release-pr.mjs");
  });
});

describeWorkflowSecurity(FILE);
