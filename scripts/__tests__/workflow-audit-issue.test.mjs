import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AUDIT_LABEL_COLOR,
  AuditOrigin,
  LOG_LIMIT,
  auditIssueComment,
  auditIssueContent,
  auditOrigin,
  parseAuditFindings,
  run,
} from "../workflow-audit-issue.mjs";
import { AUDIT_LABEL } from "../workflow-audit.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const REPO_URL = "https://github.com/owner/repo";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const RUN_URL = `${REPO_URL}/actions/runs/42`;
const LOG = [
  "✗ online audit of the workflows failed",
  "  lint:workflows:pinact:online did not run:",
  "  │ error: rate limited",
  "  2 new findings in this change:",
  "  │ .github/workflows/ci.yml:12 zizmor/impostor-commit: commit is not on any branch",
  "  │ .github/workflows/push-checks.yml:30 pinact/version-comment: the comment does not match",
  "  1 finding already on main (no open issue: the weekly run on main opens one):",
  "  │ .github/workflows/old.yml:3 zizmor/artipacked: credentials persisted",
  "",
].join("\n");

const merge = auditOrigin({
  origin: AuditOrigin.MERGE,
  sha: SHA,
  repoUrl: REPO_URL,
});
const weekly = auditOrigin({
  origin: AuditOrigin.WEEKLY,
  sha: SHA,
  repoUrl: REPO_URL,
});

function fakeGh(responses = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    const answer = responses[key];

    if (answer instanceof Error) throw answer;

    return answer ?? "";
  };

  return { gh, calls };
}

function runWith(env, responses) {
  const { gh, calls } = fakeGh(responses);
  const logs = [];
  const warnings = [];

  run(
    {
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_SHA: SHA,
      GITHUB_RUN_ID: "42",
      AUDIT_ORIGIN: AuditOrigin.MERGE,
      LOG_FILE: "workflow-audit.log",
      ...env,
    },
    {
      gh,
      readLog: () => LOG,
      log: (line) => logs.push(line),
      warn: (line) => warnings.push(line),
    },
  );

  return { calls, logs, warnings };
}

describe("auditOrigin", () => {
  it("names the commit of main with its link on a merge", () => {
    expect(merge).toEqual({
      label: "commit `0123456` of main",
      url: `${REPO_URL}/commit/${SHA}`,
      ref: SHA,
    });
  });

  it("names the weekly run without a commit, and links the findings to main", () => {
    expect(weekly).toEqual({ label: "the weekly run", url: "", ref: "main" });
  });
});

describe("parseAuditFindings", () => {
  it("reads only the new findings and the tools that did not run, leaving out what is already on main", () => {
    expect(parseAuditFindings(LOG)).toEqual({
      findings: [
        {
          file: ".github/workflows/ci.yml",
          line: "12",
          tool: "zizmor",
          rule: "impostor-commit",
        },
        {
          file: ".github/workflows/push-checks.yml",
          line: "30",
          tool: "pinact",
          rule: "version-comment",
        },
      ],
      failedTools: ["lint:workflows:pinact:online"],
    });
  });

  it("reads a single new finding", () => {
    expect(
      parseAuditFindings(
        "  1 new finding in this change:\n  │ .github/a.yml:1 zizmor/x: y\n",
      ).findings,
    ).toHaveLength(1);
  });

  it("finds nothing in an empty log", () => {
    expect(parseAuditFindings("")).toEqual({ findings: [], failedTools: [] });
  });
});

describe("auditIssueContent", () => {
  it("says where it failed, that the merge stays, links each new finding to its line and quotes the whole output", () => {
    const { title, body } = auditIssueContent({
      origin: merge,
      runUrl: RUN_URL,
      log: LOG,
      repoUrl: REPO_URL,
    });

    expect(title).toBe("Online audit of the workflows failed on main");
    expect(body).toContain("failed on commit `0123456` of main");
    expect(body).toContain("The merge is not reverted");
    expect(body).toContain(
      `- [\`.github/workflows/ci.yml:12\`](${REPO_URL}/blob/${SHA}/.github/workflows/ci.yml#L12) zizmor/impostor-commit`,
    );
    expect(body).toContain(
      "- `lint:workflows:pinact:online` did not run: the tool stopped before auditing",
    );
    expect(body).toContain(`Commit: ${REPO_URL}/commit/${SHA}`);
    expect(body).toContain(`Run: ${RUN_URL}`);
    expect(body).toContain(`\`\`\`text\n${LOG.trimEnd()}\n\`\`\``);
  });

  it("links the findings of the weekly run to main and gives no commit", () => {
    const { body } = auditIssueContent({
      origin: weekly,
      runUrl: RUN_URL,
      log: LOG,
      repoUrl: REPO_URL,
    });

    expect(body).toContain("failed on the weekly run");
    expect(body).toContain(
      `${REPO_URL}/blob/main/.github/workflows/ci.yml#L12`,
    );
    expect(body).not.toContain("Commit:");
  });

  it("cuts a long output and points to the run", () => {
    const { body } = auditIssueContent({
      origin: weekly,
      runUrl: RUN_URL,
      log: "x".repeat(LOG_LIMIT + 10),
      repoUrl: REPO_URL,
    });

    expect(body).toContain("… (output cut; see the run)");
    expect(body).not.toContain("x".repeat(LOG_LIMIT + 1));
  });

  it("explains a failure before any output", () => {
    const { body } = auditIssueContent({
      origin: weekly,
      runUrl: RUN_URL,
      log: "",
      repoUrl: REPO_URL,
    });

    expect(body).toContain(
      "The audit failed before writing its output (install, runner or network); the error is in the run.",
    );
  });

  it("fences an output that has backticks with a longer fence", () => {
    const { body } = auditIssueContent({
      origin: weekly,
      runUrl: RUN_URL,
      log: "a ```` b",
      repoUrl: REPO_URL,
    });

    expect(body).toContain("`````text\na ```` b\n`````");
  });
});

describe("auditIssueComment", () => {
  it("says it failed again, with the new findings and the output", () => {
    const comment = auditIssueComment({
      origin: merge,
      runUrl: RUN_URL,
      log: LOG,
      repoUrl: REPO_URL,
    });

    expect(
      comment.startsWith(
        "The online audit failed again on commit `0123456` of main.",
      ),
    ).toBe(true);
    expect(comment).toContain(
      `${REPO_URL}/blob/${SHA}/.github/workflows/ci.yml#L12`,
    );
    expect(comment).toContain(`Run: ${RUN_URL}`);
  });
});

describe("run", () => {
  it("creates the label and opens an issue with it when none is open", () => {
    const { calls, logs } = runWith(
      {},
      { "issue create": `${REPO_URL}/issues/7` },
    );

    expect(calls[0]).toEqual([
      "label",
      "create",
      AUDIT_LABEL,
      "--color",
      AUDIT_LABEL_COLOR,
      "--description",
      "Finding of the online audit of the workflows (zizmor and pinact)",
      "--force",
    ]);
    expect(calls[1].slice(0, 4)).toEqual([
      "issue",
      "list",
      "--label",
      AUDIT_LABEL,
    ]);
    expect(calls[2].slice(0, 6)).toEqual([
      "issue",
      "create",
      "--title",
      "Online audit of the workflows failed on main",
      "--label",
      AUDIT_LABEL,
    ]);
    expect(logs).toEqual([`Issue: ${REPO_URL}/issues/7`]);
  });

  it("comments on the open issue instead of opening another", () => {
    const open = `${REPO_URL}/issues/3`;
    const { calls, logs } = runWith({}, { "issue list": open });

    expect(calls.map((args) => args.slice(0, 2).join(" "))).toEqual([
      "label create",
      "issue list",
      "issue comment",
    ]);
    expect(calls[2][2]).toBe(open);
    expect(logs).toEqual([`Issue: ${open}`]);
  });

  it("opens the issue without the label when the label cannot be created, and warns", () => {
    const { calls, warnings } = runWith(
      {},
      { "label create": new Error("forbidden") },
    );

    expect(calls.at(-1)).not.toContain("--label");
    expect(warnings).toEqual([
      `Could not create the label ${AUDIT_LABEL}: going on without it.`,
    ]);
  });

  it("rehearses when dispatched by hand: prints the issue and touches nothing", () => {
    const { calls, logs } = runWith({ DRY_RUN: "1" });

    expect(calls).toEqual([]);
    expect(logs[0]).toMatch(
      /^\[rehearsal\] Online audit of the workflows failed on main\n/u,
    );
  });
});

describe("the npm script", () => {
  it("is audit:workflows:issue", () => {
    const { scripts } = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    );

    expect(scripts["audit:workflows:issue"]).toBe(
      "node scripts/workflow-audit-issue.mjs",
    );
  });
});
