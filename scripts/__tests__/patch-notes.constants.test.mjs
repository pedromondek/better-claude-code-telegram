import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { isAllowedBranch } from "../issue-key.mjs";
import {
  EXEMPT_HEAD_PREFIXES,
  PATCH_NOTES_HEADING,
  PATCH_NOTES_LANGUAGES,
  PATCH_NOTES_PLACEHOLDER,
  PATCH_NOTES_TEMPLATE,
} from "../patch-notes.constants.mjs";
import { releaseBranch } from "../release-pr.mjs";

const template = readFileSync(PATCH_NOTES_TEMPLATE, "utf8");

describe("patch-notes.constants › template", () => {
  it("points at the pull request template of the repository", () => {
    expect(PATCH_NOTES_TEMPLATE).toBe(".github/pull_request_template.md");
  });

  it("names the English and the Portuguese blocks as the template summaries do", () => {
    expect(PATCH_NOTES_LANGUAGES).toEqual({
      english: "🇺🇸 English",
      portuguese: "🇧🇷 Português",
    });
  });

  it("finds the heading, then each block holding the placeholder, in the template", () => {
    const blocks = Object.values(PATCH_NOTES_LANGUAGES).map(
      (label) =>
        `<details><summary>${label}</summary>\n\n${PATCH_NOTES_PLACEHOLDER}\n\n</details>`,
    );

    expect(template).toContain([PATCH_NOTES_HEADING, ...blocks].join("\n\n"));
  });
});

describe("patch-notes.constants › exempt heads", () => {
  const SAMPLES = {
    "dependabot/": "npm_and_yarn/vitest-5.0.1",
    "release/v": "0.2.0",
    "revert/": "0004-split-the-ci",
  };

  it("exempts the Dependabot, version and revert branches", () => {
    expect(EXEMPT_HEAD_PREFIXES).toEqual([
      "dependabot/",
      "release/v",
      "revert/",
    ]);
  });

  it.each(EXEMPT_HEAD_PREFIXES)(
    "keeps %j among the branches allowed outside the issue pattern",
    (prefix) => {
      expect(isAllowedBranch(`${prefix}${SAMPLES[prefix]}`)).toBe(true);
    },
  );

  it("matches the start of the version branch the prepare workflow opens", () => {
    expect(releaseBranch("0.2.0").startsWith("release/v")).toBe(true);
  });
});
