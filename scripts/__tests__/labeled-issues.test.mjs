import { describe, expect, it } from "vitest";

import { labeledIssues } from "../labeled-issues.mjs";

const LABEL = {
  label: "security",
  color: "b60205",
  description: "A known vulnerability to fix",
};

function fakeGh(answer = "") {
  const calls = [];

  return {
    calls,
    gh: (args) => {
      calls.push(args);

      return answer;
    },
  };
}

describe("labeledIssues › openIssue", () => {
  it("lists the first open issue with the label and joins its body and comments", () => {
    const { calls, gh } = fakeGh(
      JSON.stringify([
        {
          number: 7,
          body: "body",
          comments: [{ body: "first" }, { body: "second" }],
        },
      ]),
    );

    expect(labeledIssues(gh, LABEL).openIssue()).toEqual({
      number: 7,
      texts: ["body", "first", "second"],
    });
    expect(calls).toEqual([
      [
        "issue",
        "list",
        "--label",
        "security",
        "--state",
        "open",
        "--json",
        "number,body,comments",
        "--limit",
        "1",
      ],
    ]);
  });

  it("narrows the list with the search when one is given", () => {
    const { calls, gh } = fakeGh("[]");

    labeledIssues(gh, { ...LABEL, search: '"Title" in:title' }).openIssue();

    expect(calls).toEqual([
      [
        "issue",
        "list",
        "--label",
        "security",
        "--state",
        "open",
        "--search",
        '"Title" in:title',
        "--json",
        "number,body,comments",
        "--limit",
        "1",
      ],
    ]);
  });

  it("returns null when no open issue has the label", () => {
    const { gh } = fakeGh("[]");

    expect(labeledIssues(gh, LABEL).openIssue()).toBeNull();
  });
});

describe("labeledIssues › writes", () => {
  it("creates the label with its color and description, replacing an existing one", () => {
    const { calls, gh } = fakeGh();

    labeledIssues(gh, LABEL).ensureLabel();

    expect(calls).toEqual([
      [
        "label",
        "create",
        "security",
        "--color",
        "b60205",
        "--description",
        "A known vulnerability to fix",
        "--force",
      ],
    ]);
  });

  it("returns the number of the issue it creates from the url gh prints", () => {
    const { calls, gh } = fakeGh("https://github.com/owner/repo/issues/42\n");

    expect(
      labeledIssues(gh, LABEL).createIssue({
        title: "Title",
        label: "security",
        body: "Body",
      }),
    ).toBe(42);
    expect(calls).toEqual([
      [
        "issue",
        "create",
        "--title",
        "Title",
        "--label",
        "security",
        "--body",
        "Body",
      ],
    ]);
  });

  it("throws when gh prints no issue url", () => {
    const { gh } = fakeGh("something else");

    expect(() =>
      labeledIssues(gh, LABEL).createIssue({
        title: "Title",
        label: "security",
        body: "Body",
      }),
    ).toThrow(TypeError);
  });

  it("comments on the issue by its number", () => {
    const { calls, gh } = fakeGh();

    labeledIssues(gh, LABEL).comment(7, "Again");

    expect(calls).toEqual([["issue", "comment", "7", "--body", "Again"]]);
  });
});
