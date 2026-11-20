import { describe, expect, it } from "vitest";

import {
  branchName,
  branchSlug,
  inlineClosingReferences,
  isAllowedBranch,
  issueKey,
  issueNumberFromBranch,
  issueNumberFromPrTitle,
  prTitle,
} from "../issue-key.mjs";

describe("issueKey", () => {
  it("pads the issue number with zeros up to 4 digits", () => {
    expect(issueKey(42)).toBe("0042");
    expect(issueKey(7)).toBe("0007");
    expect(issueKey(1234)).toBe("1234");
  });

  it("keeps a number with more than 4 digits whole", () => {
    expect(issueKey(12345)).toBe("12345");
  });

  it.each([0, -1, 1.5, Number.NaN, "42"])(
    "refuses %s, which is not a positive integer",
    (invalid) => {
      expect(() => issueKey(invalid)).toThrow(TypeError);
    },
  );
});

describe("branchSlug", () => {
  it("turns the title into lowercase kebab-case, without accents or punctuation", () => {
    expect(branchSlug("Padronizar CI e fluxo: cards, versões!")).toBe(
      "padronizar-ci-e-fluxo-cards-versoes",
    );
  });

  it("cuts at a whole word at the 40-character limit", () => {
    const slug = branchSlug(
      "Create a Claude Code command to open the issue, branch and PR",
    );

    expect(slug).toBe("create-a-claude-code-command-to-open-the");
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  it("cuts in the middle when the first word is already over the limit", () => {
    expect(branchSlug("a".repeat(50))).toBe("a".repeat(40));
  });

  it("joins repeated separators and drops the ones at the ends", () => {
    expect(branchSlug("  --Fix   the  chat--  ")).toBe("fix-the-chat");
  });

  it("returns empty when the title has no letter or digit", () => {
    expect(branchSlug("!!! ???")).toBe("");
  });
});

describe("branchName", () => {
  it("joins the issue key and the slug of the title", () => {
    expect(branchName(38, "Fix chatting")).toBe("0038-fix-chatting");
  });

  it("refuses a title with nothing to slug", () => {
    expect(() => branchName(38, "???")).toThrow(TypeError);
  });
});

describe("issueNumberFromBranch", () => {
  it("reads the issue number of a branch in the pattern", () => {
    expect(issueNumberFromBranch("0038-fix-chatting")).toBe(38);
    expect(issueNumberFromBranch("12345-x")).toBe(12345);
  });

  it.each([
    "main",
    "upgrade-node-24",
    "38-without-zeros",
    "00038-extra-zeros",
    "0038",
    "0038-Uppercase",
    "0038-double--hyphen",
    "0038-hyphen-at-the-end-",
    "feature/0038-x",
    "0000-zero-issue",
  ])("returns null for %s, outside the pattern", (name) => {
    expect(issueNumberFromBranch(name)).toBeNull();
  });
});

describe("isAllowedBranch", () => {
  it.each([
    "0038-fix-chatting",
    "main",
    "revert/abc1234",
    "dependabot/npm_and_yarn/grammy-1.46.0",
    "release/v0.1.0-alpha.1",
    "release/v0.2.0-rc.12",
    "release/v1.0.0",
  ])("accepts %s, in the pattern or an exception", (name) => {
    expect(isAllowedBranch(name)).toBe(true);
  });

  it.each([
    "upgrade-node-24",
    "38-x",
    "0000-x",
    "main2",
    "revert",
    "dependabot",
    "release",
    "release/0.1.0",
    "release/v0.1",
    "release/v0.1.0-",
    "release/v0.1.0-alpha",
    "release/v0.1.0-alpha.0",
    "release/v0.1.0-gamma.1",
    "release/v01.0.0",
    "release/v0.1.0-alpha.1-x",
    "x-release/v0.1.0",
  ])("refuses %s", (name) => {
    expect(isAllowedBranch(name)).toBe(false);
  });
});

describe("prTitle", () => {
  it("builds the key, a colon and the title of the issue, trimmed", () => {
    expect(prTitle(43, "  Fix chatting  ")).toBe("0043: Fix chatting");
  });
});

describe("issueNumberFromPrTitle", () => {
  it("reads the issue number of a title in the pattern", () => {
    expect(issueNumberFromPrTitle("0043: Fix chatting")).toBe(43);
  });

  it.each([
    "Fix chatting 0043",
    "0043 Fix chatting",
    "43: Fix chatting",
    "00043: Fix chatting",
    "0043:Fix chatting",
    "0043: ",
    "[0043] Fix chatting",
    "0000: Fix chatting",
  ])("returns null for %s, outside the pattern", (title) => {
    expect(issueNumberFromPrTitle(title)).toBeNull();
  });
});

describe("inlineClosingReferences", () => {
  it("accepts a closing keyword on its own line, with or without the rest of the line", () => {
    const text = [
      "Closes #42",
      "  fixes: #43",
      "Resolved #44 · [board item](<https://example.test/item>)",
      "Refs #45 in the middle is fine too",
    ].join("\n");

    expect(inlineClosingReferences(text)).toEqual([]);
  });

  it("points out a closing keyword in the middle of the text, which GitHub also reads and uses to close the issue", () => {
    const text = [
      "Repairs the flow; fix #12 after the deploy",
      "Closes #44, closes #45",
      "🐛 fix: #13 breaks the login",
      "It resolves #14 and FIXED #15",
    ].join("\n");

    expect(inlineClosingReferences(text)).toEqual([
      "fix #12",
      "closes #45",
      "fix: #13",
      "resolves #14",
      "FIXED #15",
    ]);
  });

  it("ignores a keyword glued to another word or a reference without a number", () => {
    expect(
      inlineClosingReferences("The prefix #12 and unfixed #13 stay; fix #x"),
    ).toEqual([]);
  });

  it("accepts an empty or missing text", () => {
    expect(inlineClosingReferences("")).toEqual([]);
    expect(inlineClosingReferences(undefined)).toEqual([]);
  });
});
