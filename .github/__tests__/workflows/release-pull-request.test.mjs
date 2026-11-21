import { describe, expect, it } from "vitest";

import {
  describeWorkflowSecurity,
  read,
  stepNamed,
  stepUsing,
  triggers,
  workflow,
} from "../support/workflow.mjs";

const FILE = "release-pull-request.yml";
const definition = workflow(FILE);
const notes = definition.jobs["release-notes"];
const version = definition.jobs["release-version"];
const packageScripts = JSON.parse(read("package.json")).scripts;
const VERSION_BRANCH = "startsWith(github.head_ref, 'release/v')";

describe("release-pull-request.yml keeps the version pull request red until its notes are written and while its version is not free and in order", () => {
  it("has the release-notes and release-version jobs, named as the checks the description and the docs cite", () => {
    expect(Object.keys(definition.jobs)).toEqual([
      "release-notes",
      "release-version",
    ]);
    expect(notes.name).toBe("Release notes");
    expect(version.name).toBe("Release version");
  });

  it("runs apart from ci.yml, on every edit of the description and on every push, so the checks are on the head commit and an edit never cancels the CI", () => {
    expect(triggers(definition)).toEqual(["pull_request"]);
    expect(definition.on.pull_request).toEqual({
      types: ["opened", "edited", "reopened", "synchronize"],
    });
  });

  it("cancels the run that an edit or a push supersedes, one group per pull request", () => {
    expect(definition.concurrency).toEqual({
      group: "release-pull-request-${{ github.event.pull_request.number }}",
      "cancel-in-progress": true,
    });
  });

  it("checks only the version branches, and is skipped, which passes, on every other pull request", () => {
    expect(notes.if).toBe(VERSION_BRANCH);
    expect(version.if).toBe(VERSION_BRANCH);
  });

  it("sets up Node from the .nvmrc in both jobs", () => {
    for (const job of [notes, version]) {
      expect(
        stepUsing(job, "actions/setup-node").with["node-version-file"],
      ).toBe(".nvmrc");
    }
  });

  it("reads the description through env with the release:pr script", () => {
    const check = stepNamed(notes, "Notes written in the description");

    expect(check.env).toEqual({
      PR_BODY: "${{ github.event.pull_request.body }}",
    });
    expect(check.run).toBe("npm run --silent release:pr -- check-notes");
    expect(packageScripts["release:pr"]).toBe("node scripts/release-pr.mjs");
  });

  it("checks the version of the branch against every version released, with the read-only token of the run", () => {
    const check = stepNamed(version, "Version still free and in order");

    expect(check.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      GH_REPO: "${{ github.repository }}",
      PR_BRANCH: "${{ github.head_ref }}",
    });
    expect(check.run).toBe("npm run --silent release:pr -- check-version");
  });
});

describeWorkflowSecurity(FILE);
