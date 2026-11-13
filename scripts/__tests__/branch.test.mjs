import { describe, expect, it } from "vitest";

import {
  branchCheckMessage,
  createBranch,
  createIssueAndBranch,
  issueNumberFromUrl,
  pullRequestCheckMessage,
  run,
} from "../branch.mjs";

function fakeGh(issue, openSubIssues = [], newIssue = 57) {
  const calls = [];

  return {
    calls,
    createIssue: (title) => {
      calls.push(["create", title]);

      return newIssue;
    },
    viewIssue: (number) => {
      calls.push(["view", number]);
      if (issue === null) throw new Error("issue not found");

      return issue;
    },
    openSubIssues: (number) => {
      calls.push(["subIssues", number]);

      return openSubIssues;
    },
    develop: (number, name) => {
      calls.push(["develop", number, name]);
    },
  };
}

const OPEN_ISSUE = {
  number: 43,
  title: "Fix chatting in topics",
  state: "OPEN",
};

describe("createBranch", () => {
  it("creates from the open issue the branch <key>-<title>, linked to it and starting from main", () => {
    const gh = fakeGh(OPEN_ISSUE);

    expect(createBranch({ issue: "43", gh })).toBe(
      "0043-fix-chatting-in-topics",
    );
    expect(gh.calls).toEqual([
      ["view", 43],
      ["subIssues", 43],
      ["develop", 43, "0043-fix-chatting-in-topics"],
    ]);
  });

  it("refuses an epic (issue with open sub-issues) without the scope confirmation and shows both ways out", () => {
    const gh = fakeGh(OPEN_ISSUE, [44, 45]);

    expect(() => createBranch({ issue: "43", gh })).toThrow(
      /#43 has open sub-issues \(#44, #45\).*closes all of them.*npm run branch -- 43 --epic.*npm run branch -- 44/su,
    );
    expect(gh.calls).toEqual([
      ["view", 43],
      ["subIssues", 43],
    ]);
  });

  it("creates the branch of an epic with the scope confirmation (--epic)", () => {
    const gh = fakeGh(OPEN_ISSUE, [44, 45]);

    expect(createBranch({ issue: "43", epic: true, gh })).toBe(
      "0043-fix-chatting-in-topics",
    );
    expect(gh.calls.at(-1)).toEqual([
      "develop",
      43,
      "0043-fix-chatting-in-topics",
    ]);
  });

  it("takes the summary for the name instead of the title", () => {
    expect(
      createBranch({ issue: "43", summary: "Topics", gh: fakeGh(OPEN_ISSUE) }),
    ).toBe("0043-topics");
  });

  it.each(["#43", "0043"])("accepts the number written as %s", (issue) => {
    const gh = fakeGh(OPEN_ISSUE);

    createBranch({ issue, gh });

    expect(gh.calls[0]).toEqual(["view", 43]);
  });

  it("refuses a closed issue without creating the branch", () => {
    const gh = fakeGh({ ...OPEN_ISSUE, state: "CLOSED" });

    expect(() => createBranch({ issue: "43", gh })).toThrow(/closed/u);
    expect(gh.calls).toEqual([["view", 43]]);
  });

  it("refuses an argument that is not an issue number without asking GitHub", () => {
    const gh = fakeGh(OPEN_ISSUE);

    expect(() => createBranch({ issue: "abc", gh })).toThrow(/issue number/u);
    expect(gh.calls).toEqual([]);
  });
});

describe("createIssueAndBranch", () => {
  it("opens the issue first and creates the branch named after it, linked to it", () => {
    const gh = fakeGh(null);

    expect(createIssueAndBranch({ title: "  Fix chatting  ", gh })).toEqual({
      number: 57,
      name: "0057-fix-chatting",
    });
    expect(gh.calls).toEqual([
      ["create", "Fix chatting"],
      ["develop", 57, "0057-fix-chatting"],
    ]);
  });

  it("refuses a title with nothing to slug before opening any issue", () => {
    const gh = fakeGh(null);

    expect(() => createIssueAndBranch({ title: "???", gh })).toThrow(TypeError);
    expect(gh.calls).toEqual([]);
  });
});

describe("issueNumberFromUrl", () => {
  it("reads the number from the URL gh issue create prints", () => {
    expect(
      issueNumberFromUrl("https://github.com/owner/repo/issues/57\n"),
    ).toBe(57);
  });

  it("refuses an output without the URL of an issue", () => {
    expect(() => issueNumberFromUrl("Creating issue...")).toThrow(
      /did not return the URL/u,
    );
  });
});

describe("branchCheckMessage", () => {
  it.each(["0043-topics", "main", "revert/abc", "dependabot/npm/x"])(
    "lets %s through without a message",
    (name) => {
      expect(branchCheckMessage(name)).toBeNull();
    },
  );

  it("explains the pattern, how to create the branch from the issue and how to rename it", () => {
    const message = branchCheckMessage("upgrade-node-24");

    expect(message).toContain('"upgrade-node-24"');
    expect(message).toContain("0042-short-title");
    expect(message).toContain("npm run branch -- <issue number>");
    expect(message).toContain('npm run branch -- "<title>"');
    expect(message).toContain(
      "git branch -m upgrade-node-24 <issue number>-upgrade-node-24",
    );
  });
});

describe("pullRequestCheckMessage", () => {
  it("lets a title with the key of the branch issue through", () => {
    expect(
      pullRequestCheckMessage("0043: Fix chatting", "0043-fix-chatting"),
    ).toBeNull();
  });

  it.each([
    "main",
    "revert/abc",
    "dependabot/npm_and_yarn/x",
    "release/v0.1.0-alpha.1",
  ])("does not check the title of a pull request from %s", (branch) => {
    expect(
      pullRequestCheckMessage("🔐 security(root): bump x", branch),
    ).toBeNull();
  });

  it("explains the branch pattern when the branch is outside it", () => {
    expect(pullRequestCheckMessage("0043: Fix chatting", "my-branch")).toBe(
      branchCheckMessage("my-branch"),
    );
  });

  it.each([
    ["Fix chatting", "without the key"],
    ["0044: Fix chatting", "with the key of another issue"],
    ["43: Fix chatting", "with the key not padded to four digits"],
    ["0043:Fix chatting", "without the space after the colon"],
  ])("refuses the title %s, %s, and shows the expected one", (title) => {
    const message = pullRequestCheckMessage(title, "0043-fix-chatting");

    expect(message).toContain(`"${title}"`);
    expect(message).toContain("0043: <title of the issue>");
  });
});

describe("run", () => {
  const io = () => {
    const out = [];

    return { out, log: (line) => out.push(line) };
  };

  it("check exits 0 on a valid branch and 1 with the explanation on an invalid one", () => {
    const ok = io();
    const bad = io();

    expect(run(["check", "0043-topics"], { ...ok, gh: fakeGh(null) })).toBe(0);
    expect(ok.out).toEqual([]);
    expect(run(["check", "my-branch"], { ...bad, gh: fakeGh(null) })).toBe(1);
    expect(bad.out.join("\n")).toContain("outside the pattern");
  });

  it("pr exits 0 on a title with the key of the branch and 1 with the explanation otherwise", () => {
    const ok = io();
    const bad = io();
    const gh = fakeGh(null);

    expect(
      run(["pr", "0043: Fix chatting", "0043-fix-chatting"], { ...ok, gh }),
    ).toBe(0);
    expect(ok.out).toEqual([]);
    expect(
      run(["pr", "Fix chatting", "0043-fix-chatting"], { ...bad, gh }),
    ).toBe(1);
    expect(bad.out.join("\n")).toContain("0043: <title of the issue>");
    expect(gh.calls).toEqual([]);
  });

  it("pr refuses a missing title or branch", () => {
    const out = io();

    expect(
      run(["pr", "0043: Fix chatting"], { ...out, gh: fakeGh(null) }),
    ).toBe(1);
    expect(out.out.join("\n")).toContain("npm run branch -- pr");
  });

  it("creates the branch and shows its name", () => {
    const out = io();

    expect(run(["43"], { ...out, gh: fakeGh(OPEN_ISSUE) })).toBe(0);
    expect(out.out.join("\n")).toContain("0043-fix-chatting-in-topics");
  });

  it("takes --epic anywhere, as the scope confirmation, outside the summary", () => {
    const out = io();

    expect(
      run(["43", "--epic", "chat", "topics"], {
        ...out,
        gh: fakeGh(OPEN_ISSUE, [44]),
      }),
    ).toBe(0);
    expect(out.out.join("\n")).toContain("0043-chat-topics");
  });

  it("with a title instead of a number, opens the issue and creates its branch", () => {
    const out = io();
    const gh = fakeGh(null);

    expect(run(["Fix", "chatting"], { ...out, gh })).toBe(0);
    expect(gh.calls[0]).toEqual(["create", "Fix chatting"]);
    expect(out.out.join("\n")).toContain(
      "Issue #57 opened and branch 0057-fix-chatting created from main and linked to it.",
    );
  });

  it("refuses --epic with a title, since an epic is an existing issue", () => {
    const out = io();
    const gh = fakeGh(null);

    expect(run(["Fix chatting", "--epic"], { ...out, gh })).toBe(1);
    expect(gh.calls).toEqual([]);
    expect(out.out.join("\n")).toContain(
      "--epic needs the number of an existing issue",
    );
  });

  it("shows the usage and exits 1 without argument", () => {
    const out = io();

    expect(run([], { ...out, gh: fakeGh(null) })).toBe(1);
    expect(out.out.join("\n")).toContain(
      "npm run branch -- <issue number> [summary]",
    );
  });

  it("exits 1 with the message on an error from GitHub or the issue", () => {
    const out = io();

    expect(run(["43"], { ...out, gh: fakeGh(null) })).toBe(1);
    expect(out.out.join("\n")).toContain("issue not found");
  });
});
