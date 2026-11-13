import { describe, expect, it } from "vitest";

import { parse } from "yaml";

import { read } from "../support/workflow.mjs";

const config = parse(read(".github/actionlint.yaml"));
const ignored = config.paths[".github/workflows/**/*.{yml,yaml}"].ignore;
const ACTIONLINT_MESSAGE =
  'reusable workflow call "$/.github/workflows/push-checks.yml" at "uses" is not following the format "owner/repo/path/to/workflow.yml@ref" nor "./path/to/workflow.yml"';

describe("actionlint.yaml: the messages ignored on purpose", () => {
  it("ignores one message only, on the workflows only", () => {
    expect(Object.keys(config)).toEqual(["paths"]);
    expect(Object.keys(config.paths)).toEqual([
      ".github/workflows/**/*.{yml,yaml}",
    ]);
    expect(ignored).toHaveLength(1);
  });

  it("matches the message on a task called through $/, which the pinned actionlint does not know yet", () => {
    expect(new RegExp(ignored[0]).test(ACTIONLINT_MESSAGE)).toBe(true);
  });

  it("keeps reporting a malformed call outside $/ and a third-party call", () => {
    const pattern = new RegExp(ignored[0]);

    expect(
      pattern.test(
        'reusable workflow call "pedro/ci/.github/workflows/x.yml" at "uses" is not following the format',
      ),
    ).toBe(false);
    expect(
      pattern.test(
        'reusable workflow call "./.github/workflows/x.yml" at "uses" is not following the format',
      ),
    ).toBe(false);
  });
});
