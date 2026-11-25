import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import {
  CI_PASSED_JOB,
  FAILED_CONCLUSIONS,
  NO_RUNNER_ANNOTATION_LEVEL,
  NO_RUNNER_ANNOTATION_MESSAGE,
  NO_RUNNER_CONCLUSION,
  NO_RUNNER_WARNING,
} from "../ci.constants.mjs";

const NO_RUNNER = JSON.parse(
  readFileSync(
    new URL("fixtures/no-runner-jobs.json", import.meta.url),
    "utf8",
  ),
);

describe("ci.constants", () => {
  it("names the aggregator job as ci.yml does", () => {
    const ci = parse(readFileSync(".github/workflows/ci.yml", "utf8"));

    expect(CI_PASSED_JOB).toBe("CI passed");
    expect(ci.jobs["ci-passed"].name).toBe(CI_PASSED_JOB);
  });

  it("counts a failed, cancelled or timed out job as not passing", () => {
    expect(FAILED_CONCLUSIONS).toEqual(["failure", "cancelled", "timed_out"]);
  });

  it("matches the failure annotation GitHub leaves on a job that got no runner", () => {
    const [annotation] = NO_RUNNER.annotations;

    expect(NO_RUNNER_ANNOTATION_LEVEL).toBe("failure");
    expect(NO_RUNNER_ANNOTATION_MESSAGE).toBe(
      "The job was not acquired by Runner",
    );
    expect(annotation.annotation_level).toBe(NO_RUNNER_ANNOTATION_LEVEL);
    expect(annotation.message).toContain(NO_RUNNER_ANNOTATION_MESSAGE);
  });

  it("takes a job that got no runner as cancelled, a conclusion that does not pass", () => {
    expect(NO_RUNNER_CONCLUSION).toBe("cancelled");
    expect(NO_RUNNER.jobs.map(({ conclusion }) => conclusion)).toEqual([
      NO_RUNNER_CONCLUSION,
      NO_RUNNER_CONCLUSION,
    ]);
    expect(FAILED_CONCLUSIONS).toContain(NO_RUNNER_CONCLUSION);
  });

  it("warns that the job got no runner and did not run", () => {
    expect(NO_RUNNER_WARNING).toBe("got no runner and did not run");
  });
});
