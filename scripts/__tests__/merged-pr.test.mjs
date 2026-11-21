import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MERGED_PR_CHOICES,
  mergedPrTarget,
  parseMerges,
  pickMergedPr,
} from "../merged-pr.mjs";

const SCRIPT = join(import.meta.dirname, "..", "merged-pr.mjs");

const sha = (digit) => digit.repeat(40);

const record = (fields) => `${fields.join("\x1f")}\x1e`;

const merge = (number, digit, parent, title = `PR ${number}`) => ({
  number,
  title,
  sha: sha(digit),
  before: sha(parent),
});

describe("merged-pr › parseMerges", () => {
  it("reads every pull request merge of the log, with the number, the title from the body and the first parent", () => {
    const log = [
      record([
        sha("a"),
        `${sha("b")} ${sha("c")}`,
        "Merge pull request #34 from owner/0034-fix-chatting",
        "🐛 fix(telegram): keep the chat open\n",
      ]),
      record([
        sha("b"),
        `${sha("d")} ${sha("e")}`,
        "Merge pull request #33 from owner/0033-split-ci",
        "\n🔧 chore(ci): split the workflows\n\nextra body",
      ]),
    ].join("\n");

    expect(parseMerges(log)).toEqual([
      merge(34, "a", "b", "🐛 fix(telegram): keep the chat open"),
      merge(33, "b", "d", "🔧 chore(ci): split the workflows"),
    ]);
  });

  it("skips a merge that did not come from a pull request and an empty log", () => {
    const log = record([
      sha("a"),
      `${sha("b")} ${sha("c")}`,
      "Merge branch 'main' into 0034-fix-chatting",
      "",
    ]);

    expect(parseMerges(log)).toEqual([]);
    expect(parseMerges("")).toEqual([]);
  });

  it("leaves the title empty for a pull request merge without a body", () => {
    const log = record([
      sha("a"),
      `${sha("b")} ${sha("c")}`,
      "Merge pull request #7 from owner/0007-x",
      "",
    ]);

    expect(parseMerges(log)).toEqual([merge(7, "a", "b", "")]);
  });

  it("reads a record whose fields are missing as an empty subject, without failing", () => {
    expect(parseMerges(record([sha("a")]))).toEqual([]);
  });
});

describe("merged-pr › pickMergedPr", () => {
  const merges = [
    merge(34, "a", "b"),
    merge(33, "b", "c"),
    merge(32, "c", "d"),
  ];

  it("offers the three latest pull requests, from the last to the third to last", () => {
    expect(MERGED_PR_CHOICES).toEqual([
      "Last merged PR",
      "Second to last merged PR",
      "Third to last merged PR",
    ]);
  });

  it.each(MERGED_PR_CHOICES.map((choice, index) => [choice, index]))(
    '"%s" picks the merge at position %i of main',
    (choice, index) => {
      expect(pickMergedPr(merges, { choice })).toEqual(merges[index]);
    },
  );

  it("lets the number win over the select, ignoring the spaces around it", () => {
    expect(
      pickMergedPr(merges, { choice: MERGED_PR_CHOICES[0], number: " 32 " }),
    ).toEqual(merges[2]);
  });

  it("throws naming the number when that pull request was not merged into main", () => {
    expect(() => pickMergedPr(merges, { choice: "", number: "99" })).toThrow(
      "Pull request #99 was not merged into main.",
    );
  });

  it("throws before looking up a number that is not a number", () => {
    expect(() => pickMergedPr(merges, { choice: "", number: "3a" })).toThrow(
      'Invalid pull request number: "3a".',
    );
  });

  it("throws on a choice outside the select", () => {
    expect(() => pickMergedPr(merges, { choice: "Any PR" })).toThrow(
      'Unknown pull request choice: "Any PR".',
    );
  });

  it("throws when main has fewer merges than the position asked", () => {
    expect(() =>
      pickMergedPr(merges.slice(0, 2), { choice: MERGED_PR_CHOICES[2] }),
    ).toThrow('Main has no "Third to last merged PR" yet.');
  });
});

describe("merged-pr › mergedPrTarget", () => {
  it("builds the #N - title label and the range from the first parent to the merge", () => {
    expect(mergedPrTarget(merge(33, "b", "c", "split ci"))).toEqual({
      number: 33,
      label: "#33 - split ci",
      sha: sha("b"),
      before: sha("c"),
    });
  });

  it("keeps only the number in the label when the merge has no title", () => {
    expect(mergedPrTarget(merge(33, "b", "c", "")).label).toBe("#33");
  });
});

describe("merged-pr › command line", () => {
  let repo;
  let output;
  let summary;

  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd: repo, encoding: "utf8" },
    ).trim();

  function mergePr(number, branch, title) {
    git("switch", "-q", "-c", branch);
    writeFileSync(join(repo, `${branch}.txt`), branch);
    git("add", ".");
    git("commit", "-q", "-m", `commit of ${branch}`);
    git("switch", "-q", "main");
    git(
      "merge",
      "-q",
      "--no-ff",
      branch,
      "-m",
      `Merge pull request #${number} from owner/${branch}`,
      "-m",
      title,
    );

    return git("rev-parse", "HEAD");
  }

  const run = (env) =>
    spawnSync(process.execPath, [SCRIPT], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        ...env,
      },
    });

  beforeEach(() => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "bcct-merged-pr-")));

    repo = join(base, "repo");
    output = join(base, "output");
    summary = join(base, "summary");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    writeFileSync(output, "");
    writeFileSync(summary, "");
    writeFileSync(join(repo, "base.txt"), "base");
    git("add", ".");
    git("commit", "-q", "-m", "base");
  });

  afterEach(() => {
    rmSync(join(repo, ".."), { recursive: true, force: true });
  });

  it("resolves the chosen pull request, writes the outputs and opens the summary with it", () => {
    const first = git("rev-parse", "HEAD");
    const merged33 = mergePr(33, "0033-split-ci", "🔧 chore(ci): split ci");
    mergePr(34, "0034-fix-chatting", "🐛 fix(telegram): chatting");

    const result = run({ PR_CHOICE: MERGED_PR_CHOICES[1], PR_NUMBER: "" });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(
      [
        "number=33",
        "label=#33 - 🔧 chore(ci): split ci",
        `sha=${merged33}`,
        `before=${first}`,
        "",
      ].join("\n"),
    );
    expect(readFileSync(summary, "utf8")).toBe(
      `PR #33 - 🔧 chore(ci): split ci · range ${first.slice(0, 7)}..${merged33.slice(0, 7)}\n`,
    );
  });

  it("lets the pull request number win over the select", () => {
    const merged33 = mergePr(33, "0033-split-ci", "split ci");
    mergePr(34, "0034-fix-chatting", "chatting");

    const result = run({ PR_CHOICE: MERGED_PR_CHOICES[0], PR_NUMBER: "33" });

    expect(result.status).toBe(0);
    expect(readFileSync(output, "utf8")).toContain(`sha=${merged33}\n`);
  });

  it("fails with the reason on stderr and writes no output when the pull request was not merged", () => {
    mergePr(34, "0034-fix-chatting", "chatting");

    const result = run({ PR_CHOICE: MERGED_PR_CHOICES[0], PR_NUMBER: "99" });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("Pull request #99 was not merged into main.\n");
    expect(readFileSync(output, "utf8")).toBe("");
    expect(readFileSync(summary, "utf8")).toBe("");
  });

  it("fails when main has no pull request merge yet", () => {
    const result = run({ PR_CHOICE: MERGED_PR_CHOICES[0] });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('Main has no "Last merged PR" yet.\n');
  });

  it("writes the outputs without a summary file outside the runner", () => {
    mergePr(34, "0034-fix-chatting", "chatting");

    const result = run({
      PR_CHOICE: MERGED_PR_CHOICES[0],
      GITHUB_STEP_SUMMARY: "",
    });

    expect(result.status).toBe(0);
    expect(readFileSync(output, "utf8")).toContain("number=34\n");
    expect(readFileSync(summary, "utf8")).toBe("");
  });

  it("does nothing when imported, only when run as a script", async () => {
    await import("../merged-pr.mjs");

    expect(readFileSync(output, "utf8")).toBe("");
  });
});
