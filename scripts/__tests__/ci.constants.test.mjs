import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { CI_PASSED_JOB, FAILED_CONCLUSIONS } from "../ci.constants.mjs";

describe("ci.constants", () => {
  it("names the aggregator job as ci.yml does", () => {
    const ci = parse(readFileSync(".github/workflows/ci.yml", "utf8"));

    expect(CI_PASSED_JOB).toBe("CI passed");
    expect(ci.jobs["ci-passed"].name).toBe(CI_PASSED_JOB);
  });

  it("counts a failed, cancelled or timed out job as not passing", () => {
    expect(FAILED_CONCLUSIONS).toEqual(["failure", "cancelled", "timed_out"]);
  });
});
