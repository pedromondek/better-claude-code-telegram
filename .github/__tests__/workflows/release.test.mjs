import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MERGED_PR_CHOICES } from "../../../scripts/merged-pr.mjs";
import { compareVersions } from "../../../scripts/release-order.mjs";
import { MIN_DIST_TAG_NPM } from "../../../scripts/release.constants.mjs";
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
const {
  plan,
  build,
  publish,
  npm,
  approval,
  latest,
  verify,
  stable,
  announce,
} = definition.jobs;
const packageScripts = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
).scripts;

describe("release.yml publishes the version pull request that was merged", () => {
  it("runs on each push to main, whose ref the main-only environments accept, and by hand on a merged one", () => {
    expect(triggers(definition)).toEqual(["push", "workflow_dispatch"]);
    expect(definition.on.push).toEqual({ branches: ["main"] });
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
      only_latest: {
        description: expect.any(String),
        required: false,
        type: "boolean",
        default: false,
      },
    });
  });

  it("runs one release at a time without cancelling one, and queues only the runs that publish", () => {
    expect(definition.concurrency).toEqual({
      group: `\${{ (${plan.if}) && 'release' || format('release-skipped-{0}', github.run_id) }}`,
      "cancel-in-progress": false,
    });
  });

  it("has the plan, build, publish, npm, approval, latest, verify, stable and announce jobs, in this order of needs", () => {
    expect(Object.keys(definition.jobs)).toEqual([
      "plan",
      "build",
      "publish",
      "npm",
      "approval",
      "latest",
      "verify",
      "stable",
      "announce",
    ]);
    expect(announce.needs).toEqual(["plan", "verify"]);
    expect(stable.needs).toEqual(["plan", "verify"]);
    expect(build.needs).toEqual(["plan"]);
    expect(publish.needs).toEqual(["plan", "build"]);
    expect(npm.needs).toEqual(["plan", "publish"]);
    expect(approval.needs).toEqual(["plan", "npm"]);
    expect(latest.needs).toEqual(["plan", "approval"]);
    expect(verify.needs).toEqual(["plan", "latest"]);
  });

  it("runs only the latest job and the verify on a dispatch with only_latest, which never builds, publishes or announces again", () => {
    expect(build.if).toBe(
      "needs.plan.outputs.number != '' && inputs.only_latest != true",
    );
    expect(latest.if).toBe(
      "${{ !cancelled() && needs.plan.outputs.number != '' && (needs.approval.result == 'success' || inputs.only_latest == true) }}",
    );
    expect(verify.if).toBe(
      "${{ !cancelled() && needs.latest.result == 'success' }}",
    );
    expect(stable.if).toBe(
      "needs.plan.outputs.prerelease == 'false' && inputs.only_latest != true",
    );
    expect(announce.if).toBe("inputs.only_latest != true");
  });

  describe("latest", () => {
    it("moves latest only from the release environment, with the OIDC token of trusted publishing and nothing to write in the repository", () => {
      expect(latest.environment).toBe("release");
      expect(latest.permissions).toEqual({
        contents: "read",
        "id-token": "write",
      });
      expect(JSON.stringify(latest)).not.toMatch(/secrets\.|NODE_AUTH_TOKEN/u);
    });

    it("points setup-node at the npm registry and installs an npm that moves dist-tags through trusted publishing", () => {
      expect(stepUsing(latest, "actions/setup-node").with).toEqual({
        "node-version-file": ".nvmrc",
        "registry-url": "https://registry.npmjs.org",
      });

      const install = stepNamed(latest, "npm that moves dist-tags");
      const version = /^npm install --global npm@(\S+)$/u.exec(
        install.run,
      )?.[1];

      expect(version).toBeDefined();
      expect(compareVersions(version, MIN_DIST_TAG_NPM)).toBeGreaterThanOrEqual(
        0,
      );
    });

    it("moves latest through release:npm:publish, with the planned version", () => {
      const step = stepNamed(latest, "Latest on npm");

      expect(step.env).toEqual({
        VERSION: "${{ needs.plan.outputs.version }}",
      });
      expect(step.run).toBe("npm run --silent release:npm:publish -- latest");
    });
  });

  describe("approval", () => {
    it("waits in the npm-approved environment, whose reviewer approves once the 7 packages are approved on npmjs.com, since npm sends no event of it", () => {
      expect(approval.environment).toBe("npm-approved");
      expect(approval.permissions).toEqual({ contents: "read" });
      expect(JSON.stringify(approval)).not.toMatch(/secrets\./u);
    });

    it("only records the approval, with the version through env", () => {
      const step = stepNamed(approval, "Approved on npm");

      expect(approval.steps).toHaveLength(2);
      expect(approval.steps.at(-1)).toBe(step);
      expect(step.env).toEqual({
        VERSION: "${{ needs.plan.outputs.version }}",
      });
      expect(step.run).toBe(
        'echo "v${VERSION} was approved on npm, so its packages are public"',
      );
    });
  });

  describe("verify", () => {
    it("checks the Release and the npm packages through verify-release.yml, with the version pull request", () => {
      expect(verify.uses).toBe(`${LOCAL_WORKFLOW}verify-release.yml`);
      expect(verify.with).toEqual({
        pr_number: "${{ needs.plan.outputs.number }}",
      });
    });

    it("grants the verify what reading the attestations needs", () => {
      expect(verify.permissions).toEqual({
        contents: "read",
        attestations: "read",
      });
    });
  });

  describe("announce", () => {
    it("announces the verified version on Telegram through announce-release.yml, with the version pull request", () => {
      expect(announce.uses).toBe(`${LOCAL_WORKFLOW}announce-release.yml`);
      expect(announce.with).toEqual({
        pr_number: "${{ needs.plan.outputs.number }}",
      });
    });

    it("passes the bot token by name, the only secret the called job reads, and lets it read the version pull request and link the Release", () => {
      expect(announce.secrets).toEqual({
        TELEGRAM_ANNOUNCE_TOKEN: "${{ secrets.TELEGRAM_ANNOUNCE_TOKEN }}",
      });
      expect(announce.permissions).toEqual({
        contents: "write",
        "pull-requests": "read",
      });
    });
  });

  describe("stable", () => {
    it("runs only for a stable version, whose users follow stable, while a pre-release keeps its tag", () => {
      expect(stable.if).toContain("needs.plan.outputs.prerelease == 'false'");
    });

    it("reads the release app key only in the release environment, with a read-only GITHUB_TOKEN", () => {
      expect(stable.environment).toBe("release");
      expect(stable.permissions).toEqual({ contents: "read" });
      expect(stepUsing(stable, "actions/create-github-app-token").with).toEqual(
        {
          "client-id": "${{ vars.RELEASE_APP_CLIENT_ID }}",
          "private-key": "${{ secrets.RELEASE_APP_PRIVATE_KEY }}",
          "permission-contents": "write",
        },
      );
    });

    it("checks out the verified record", () => {
      expect(stepUsing(stable, "actions/checkout").with).toEqual({
        ref: "${{ needs.verify.outputs.commit }}",
        "persist-credentials": false,
      });
    });

    it("moves stable forward to the commit the verify hands over, through release:publish, the only step with the app token", () => {
      const step = stepNamed(stable, "Stable");

      expect(step.env).toEqual({
        GH_TOKEN: "${{ steps.app.outputs.token }}",
        GH_REPO: "${{ github.repository }}",
        VERSION: "${{ needs.plan.outputs.version }}",
        COMMIT: "${{ needs.verify.outputs.commit }}",
      });
      expect(step.run).toBe("npm run --silent release:publish -- stable");
      expect(stable.steps.at(-1)).toBe(step);
      for (const item of stable.steps.filter((entry) => entry !== step)) {
        expect(JSON.stringify(item.env ?? {})).not.toContain("steps.app");
      }
    });
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
    it("runs by hand, or on the push of the merge commit of a version branch, skipping every other push to main", () => {
      expect(plan.if).toBe(
        "github.event_name == 'workflow_dispatch' || (startsWith(github.event.head_commit.message, 'Merge pull request ') && contains(github.event.head_commit.message, '/release/v'))",
      );
    });

    it("only reads the code and the pull request", () => {
      expect(plan.permissions).toEqual({
        contents: "read",
        "pull-requests": "read",
      });
    });

    it("finds the merged pull request through merged-pr, from the history of main: the pushed merge commit, or the select and number of a dispatch", () => {
      const target = stepById(plan, "target");

      expect(stepUsing(plan, "actions/checkout").with).toEqual({
        "fetch-depth": 0,
        "persist-credentials": false,
      });
      expect(target.if).toBeUndefined();
      expect(target.env).toEqual({
        PR_CHOICE: "${{ inputs.pr }}",
        PR_NUMBER: "${{ inputs.pr_number }}",
        PR_SHA: "${{ github.event_name == 'push' && github.sha || '' }}",
      });
      expect(target.run).toBe("npm run --silent merged-pr");
    });

    it("plans only a dispatch or the push of a release/v merge, so a merge that only quotes a version branch, as its revert, skips the release", () => {
      expect(stepById(plan, "plan").if).toBe(
        "github.event_name == 'workflow_dispatch' || steps.target.outputs.release == 'true'",
      );
      expect(build.if).toContain("needs.plan.outputs.number != ''");
    });

    it("plans through release:publish with the pull request merged-pr found", () => {
      const step = stepById(plan, "plan");

      expect(step.env).toEqual({
        GH_TOKEN: "${{ github.token }}",
        GH_REPO: "${{ github.repository }}",
        PR_NUMBER: "${{ steps.target.outputs.number }}",
        ONLY_LATEST: "${{ inputs.only_latest }}",
      });
      expect(step.run).toBe("npm run --silent release:publish -- plan");
      expect(packageScripts["release:publish"]).toBe(
        "node scripts/release-publish.mjs",
      );
      expect(plan.outputs).toEqual({
        number: "${{ steps.plan.outputs.number }}",
        version: "${{ steps.plan.outputs.version }}",
        merge: "${{ steps.plan.outputs.merge }}",
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
