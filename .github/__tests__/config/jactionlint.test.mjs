import { describe, expect, it } from "vitest";

import { parse } from "yaml";

import { read } from "../support/workflow.mjs";

const config = parse(read(".github/jactionlint.yaml"));
const script = JSON.parse(read("package.json")).scripts[
  "lint:workflows:jactionlint"
];

describe("jactionlint.yaml: only the checks of the calls between workflows", () => {
  it("keeps the correctness profile and nothing else, since the script selects the rules", () => {
    expect(config).toEqual({ profile: "correctness" });
  });

  it("selects only the rules of the calls between workflows and the pipeline without pipefail, which actionlint does not cover", () => {
    expect(script.split("--select=")[1].split(",")).toEqual([
      "workflow-call-permissions",
      "missing-workflow-input",
      "unknown-workflow-input",
      "workflow-input-type",
      "invalid-local-workflow",
      "pipeline-without-pipefail",
    ]);
  });
});
