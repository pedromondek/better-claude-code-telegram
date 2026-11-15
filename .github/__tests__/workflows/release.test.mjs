import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MERGED_PR_CHOICES } from "../../../scripts/merged-pr.mjs";
import {
  LOCAL_WORKFLOW,
  ROOT,
  describeWorkflowSecurity,
  stepById,
  stepNamed,
  stepUsing,
  triggers,
  workflow,
} from "../support/workflow.mjs";

const FILE = "release.yml";
const definition = workflow(FILE);
const { plan, build, publish, npm } = definition.jobs;
const packageScripts = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
).scripts;

describe("release.yml publishes the version pull request that was merged", () => {
  it("runs when a pull request into main closes, and by hand on a merged one", () => {
    expect(triggers(definition)).toEqual(["pull_request", "workflow_dispatch"]);
    expect(definition.on.pull_request).toEqual({
      types: ["closed"],
      branches: ["main"],
    });
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

  it("never cancels a release in progress, and runs one at a time", () => {
    expect(definition.concurrency).toEqual({
      group: "release",
      "cancel-in-progress": false,
    });
  });

  it("has the plan, build, publish and npm jobs, in this order of needs", () => {
    expect(Object.keys(definition.jobs)).toEqual([
      "plan",
      "build",
      "publish",
      "npm",
    ]);
    expect(build.needs).toEqual(["plan"]);
    expect(publish.needs).toEqual(["plan", "build"]);
    expect(npm.needs).toEqual(["plan", "publish"]);
  });

  describe("npm", () => {
    it("stages on npm only from the release environment, with the OIDC token of trusted publishing and nothing to write in the repository", () => {
      expect(npm.environment).toBe("release");
      expect(npm.permissions).toEqual({
        contents: "read",
        "id-token": "write",
      });
      expect(JSON.stringify(npm)).not.toMatch(/secrets\.|NODE_AUTH_TOKEN/u);
    });

    it("builds the packages at the recorded commit, whose checksums.txt has the version, which the publish job hands over", () => {
      expect(publish.outputs).toEqual({
        commit: "${{ steps.record.outputs.commit }}",
      });
      expect(stepUsing(npm, "actions/checkout").with).toEqual({
        ref: "${{ needs.publish.outputs.commit }}",
        "persist-credentials": false,
      });
    });

    it("points setup-node at the npm registry, as the trusted publishing example does", () => {
      expect(stepUsing(npm, "actions/setup-node").with).toEqual({
        "node-version-file": ".nvmrc",
        "registry-url": "https://registry.npmjs.org",
      });
    });

    it("gathers the binaries, builds the 7 packages through release:npm and stages them through release:npm:publish", () => {
      const packages = stepNamed(npm, "npm packages");
      const stage = stepNamed(npm, "Stage on npm");

      expect(stepUsing(npm, "actions/download-artifact").with).toEqual({
        pattern: "bcct-*",
        "merge-multiple": true,
        path: "dist",
      });
      expect(packages.run).toBe(
        "npm run --silent release:npm -- dist dist/npm",
      );
      expect(stage.env).toEqual({
        VERSION: "${{ needs.plan.outputs.version }}",
      });
      expect(stage.run).toBe(
        "npm run --silent release:npm:publish -- stage dist/npm",
      );
      expect(npm.steps.at(-1)).toBe(stage);
    });
  });

  describe("plan", () => {
    it("runs by hand, or when the closed pull request was merged from a version branch", () => {
      expect(plan.if).toBe(
        "github.event_name == 'workflow_dispatch' || (github.event.pull_request.merged == true && startsWith(github.event.pull_request.head.ref, 'release/v'))",
      );
    });

    it("only reads the code and the pull request", () => {
      expect(plan.permissions).toEqual({
        contents: "read",
        "pull-requests": "read",
      });
    });

    it("finds the merged pull request of a dispatch through merged-pr, from the history of main", () => {
      const target = stepById(plan, "target");

      expect(stepUsing(plan, "actions/checkout").with).toEqual({
        "fetch-depth": 0,
        "persist-credentials": false,
      });
      expect(target.if).toBe("github.event_name == 'workflow_dispatch'");
      expect(target.env).toEqual({
        PR_CHOICE: "${{ inputs.pr }}",
        PR_NUMBER: "${{ inputs.pr_number }}",
      });
      expect(target.run).toBe("npm run --silent merged-pr");
    });

    it("plans through release:publish with the pull request of the event or of the dispatch", () => {
      const step = stepById(plan, "plan");

      expect(step.env).toEqual({
        GH_TOKEN: "${{ github.token }}",
        GH_REPO: "${{ github.repository }}",
        PR_NUMBER:
          "${{ steps.target.outputs.number || github.event.pull_request.number }}",
      });
      expect(step.run).toBe("npm run --silent release:publish -- plan");
      expect(packageScripts["release:publish"]).toBe(
        "node scripts/release-publish.mjs",
      );
      expect(plan.outputs).toEqual({
        number: "${{ steps.plan.outputs.number }}",
        version: "${{ steps.plan.outputs.version }}",
        merge: "${{ steps.plan.outputs.merge }}",
        recorded: "${{ steps.plan.outputs.recorded }}",
        prerelease: "${{ steps.plan.outputs.prerelease }}",
      });
    });
  });

  describe("build", () => {
    it("builds and attests the 6 binaries at the merge commit through build-binaries.yml", () => {
      expect(build.uses).toBe(`${LOCAL_WORKFLOW}build-binaries.yml`);
      expect(build.with).toEqual({
        attest: true,
        ref: "${{ needs.plan.outputs.merge }}",
      });
    });

    it("grants the build what the attestation needs", () => {
      expect(build.permissions).toEqual({
        contents: "read",
        "id-token": "write",
        attestations: "write",
      });
    });
  });

  describe("publish", () => {
    it("reads the release app key only in the release environment, with a read-only GITHUB_TOKEN", () => {
      expect(publish.environment).toBe("release");
      expect(publish.permissions).toEqual({ contents: "read" });
    });

    it("checks out the merge commit, whose checksums.txt the record appends to", () => {
      expect(stepUsing(publish, "actions/checkout").with).toEqual({
        ref: "${{ needs.plan.outputs.merge }}",
        "persist-credentials": false,
      });
    });

    it("takes the token of the release app with contents only, to commit on main and publish the Release", () => {
      expect(
        stepUsing(publish, "actions/create-github-app-token").with,
      ).toEqual({
        "client-id": "${{ vars.RELEASE_APP_CLIENT_ID }}",
        "private-key": "${{ secrets.RELEASE_APP_PRIVATE_KEY }}",
        "permission-contents": "write",
      });
    });

    it("gathers the binaries and their sha256 of every target into one folder", () => {
      expect(stepUsing(publish, "actions/download-artifact").with).toEqual({
        pattern: "bcct-*",
        "merge-multiple": true,
        path: "dist",
      });
    });

    it("records the checksums and the notes, then publishes the Release at that commit", () => {
      const record = stepById(publish, "record");
      const release = stepNamed(publish, "Release");
      const shared = {
        GH_TOKEN: "${{ steps.app.outputs.token }}",
        GH_REPO: "${{ github.repository }}",
        PR_NUMBER: "${{ needs.plan.outputs.number }}",
        VERSION: "${{ needs.plan.outputs.version }}",
      };

      expect(record.env).toEqual({
        ...shared,
        MERGE: "${{ needs.plan.outputs.merge }}",
        RECORDED: "${{ needs.plan.outputs.recorded }}",
      });
      expect(record.run).toBe(
        "npm run --silent release:publish -- record dist",
      );
      expect(release.env).toEqual({
        ...shared,
        COMMIT: "${{ steps.record.outputs.commit }}",
        PRERELEASE: "${{ needs.plan.outputs.prerelease }}",
      });
      expect(release.run).toBe(
        "npm run --silent release:publish -- release dist",
      );
      expect(publish.steps.at(-1)).toBe(release);
    });

    it("gives the app token to no step but the two that publish", () => {
      for (const item of publish.steps.filter(
        (entry) => entry.id !== "record" && entry.name !== "Release",
      )) {
        expect(JSON.stringify(item.env ?? {})).not.toContain("steps.app");
      }
    });
  });
});

describeWorkflowSecurity(FILE);
