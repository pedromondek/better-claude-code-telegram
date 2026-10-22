import { describe, expect, it } from "vitest";

import { inlineClosingReferences } from "../issue-key.mjs";

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
