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

const FILE = "announce-release.yml";
const definition = workflow(FILE);
const { record, announce } = definition.jobs;
const packageScripts = JSON.parse(read("package.json")).scripts;

describe("announce-release.yml announces a published version on the Telegram channels", () => {
  it("has the record and announce jobs, the announce after the record", () => {
    expect(Object.keys(definition.jobs)).toEqual(["record", "announce"]);
    expect(announce.needs).toEqual(["record"]);
  });

  it("is called by the release with the number of the version pull request", () => {
    expect(triggers(definition)).toEqual([
      "workflow_call",
      "workflow_dispatch",
    ]);
    expect(definition.on.workflow_call).toEqual({
      inputs: {
        pr_number: {
          description: expect.any(String),
          required: true,
          type: "string",
        },
      },
      secrets: {
        TELEGRAM_ANNOUNCE_TOKEN: {
          description: expect.any(String),
          required: true,
        },
      },
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
      resume: {
        description: expect.any(String),
        required: false,
        type: "string",
        default: "",
      },
    });
  });

  describe("record", () => {
    it("only reads the code and the version pull request, outside any environment and with no secret", () => {
      expect(record.permissions).toEqual({
        contents: "read",
        "pull-requests": "read",
      });
      expect(record.environment).toBeUndefined();
      expect(JSON.stringify(record)).not.toMatch(/secrets\.|TELEGRAM/u);
    });

    it("finds the pull request of a dispatch through merged-pr, from the history of main", () => {
      const target = stepById(record, "target");

      expect(stepUsing(record, "actions/checkout").with).toEqual({
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

    it("hands over the version and its record commit through release:verify -- record, with the GITHUB_TOKEN", () => {
      const step = stepById(record, "record");

      expect(step.env).toEqual({
        GH_TOKEN: "${{ github.token }}",
        GH_REPO: "${{ github.repository }}",
        PR_NUMBER: "${{ steps.target.outputs.number || inputs.pr_number }}",
      });
      expect(step.run).toBe("npm run --silent release:verify -- record");
      expect(record.outputs).toEqual({
        commit: "${{ steps.record.outputs.commit }}",
        version: "${{ steps.record.outputs.version }}",
      });
      expect(record.steps.at(-2)).toBe(step);
    });

    it("refuses a dispatch while npm does not serve the version of all 7 packages, as before the npm approval", () => {
      const step = stepNamed(record, "Public on npm");

      expect(step.if).toBe("github.event_name == 'workflow_dispatch'");
      expect(step.env).toEqual(stepById(record, "record").env);
      expect(step.run).toBe("npm run --silent release:verify -- public");
      expect(record.steps.at(-1)).toBe(step);
    });
  });

  describe("announce", () => {
    it("reads the bot token only in the telegram-announce environment, with a read-only GITHUB_TOKEN", () => {
      expect(announce.environment).toBe("telegram-announce");
      expect(announce.permissions).toEqual({ contents: "read" });
    });

    it("checks out the record commit, whose docs/releases holds the notes of the version", () => {
      expect(stepUsing(announce, "actions/checkout").with).toEqual({
        ref: "${{ needs.record.outputs.commit }}",
        "persist-credentials": false,
      });
      expect(stepUsing(announce, "actions/setup-node").with).toEqual({
        "node-version-file": ".nvmrc",
      });
    });

    it("posts through release:announce, the only step with the token, the test channel and the dry run", () => {
      const step = stepNamed(announce, "Telegram channels");

      expect(step.env).toEqual({
        VERSION: "${{ needs.record.outputs.version }}",
        GH_REPO: "${{ github.repository }}",
        TELEGRAM_ANNOUNCE_TOKEN: "${{ secrets.TELEGRAM_ANNOUNCE_TOKEN }}",
        TELEGRAM_TEST_CHANNEL: "${{ vars.TELEGRAM_TEST_CHANNEL }}",
        DRY_RUN: "${{ vars.DRY_RUN }}",
        ANNOUNCE_RESUME: "${{ inputs.resume }}",
      });
      expect(step.run).toBe("npm run --silent release:announce");
      expect(packageScripts["release:announce"]).toBe(
        "node scripts/release-announce.mjs",
      );
      expect(announce.steps.at(-1)).toBe(step);
      for (const item of announce.steps.filter((entry) => entry !== step)) {
        expect(JSON.stringify(item)).not.toMatch(/secrets\.|vars\./u);
      }
    });
  });
});

describeTaskContract(FILE);
describeWorkflowSecurity(FILE);
