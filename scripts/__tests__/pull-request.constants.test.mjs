import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CODERABBIT_APP,
  CODERABBIT_CHECK,
  LOCK_WORKFLOW,
  PULL_REQUEST_NUMBER,
  invalidPullRequestNumber,
} from "../pull-request.constants.mjs";

describe("pull-request.constants", () => {
  it.each(["1", "12", "1000"])(
    "accepts %j as a pull request number",
    (value) => {
      expect(PULL_REQUEST_NUMBER.test(value)).toBe(true);
    },
  );

  it.each(["", "0", "012", "-1", "12a", " 12", "12/merge"])(
    "refuses %j as a pull request number",
    (value) => {
      expect(PULL_REQUEST_NUMBER.test(value)).toBe(false);
    },
  );

  it("names the value that is not a pull request number", () => {
    expect(invalidPullRequestNumber("12/merge")).toBe(
      'PR_NUMBER must be the number of a pull request, not "12/merge"',
    );
  });

  it("names the CodeRabbit check and the slug of its app", () => {
    expect(CODERABBIT_CHECK).toBe("CodeRabbit");
    expect(CODERABBIT_APP).toBe("coderabbitai");
  });

  it("names the lock workflow that exists in .github/workflows", () => {
    expect(LOCK_WORKFLOW).toBe("lock-pull-requests.yml");
    expect(
      existsSync(
        join(import.meta.dirname, "../../.github/workflows", LOCK_WORKFLOW),
      ),
    ).toBe(true);
  });
});
