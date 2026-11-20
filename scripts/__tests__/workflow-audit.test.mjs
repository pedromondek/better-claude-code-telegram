import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AUDIT_STEP,
  annotations,
  auditLog,
  AUDIT_LABEL,
  classifyFindings,
  openAuditIssue,
  pinactFindings,
  shouldAudit,
  zizmorFindings,
} from "../workflow-audit.mjs";

const SCRIPT = join(import.meta.dirname, "..", "workflow-audit.mjs");
const ISSUE_URL = "https://github.com/org/repo/issues/77";

const zizmorResult = ({ ident, path, route, row, desc = `${ident} desc` }) => ({
  ident,
  desc,
  locations: [
    {
      symbolic: {
        key: { Local: { verbatim_path: path } },
        route: { route },
        kind: "Primary",
      },
      concrete: { location: { start_point: { row, column: 0 } } },
    },
  ],
});

const sarif = (results) => ({ runs: [{ results }] });
const sarifResult = ({ ruleId, uri, line, text = `${ruleId} text` }) => ({
  ruleId,
  message: { text },
  locations: [
    {
      physicalLocation: {
        artifactLocation: { uri },
        region: { startLine: line },
      },
    },
  ],
});

const stepLines = (log) =>
  log.split("\n").filter((line) => /^[✓✗⚠]/u.test(line));

const finding = (overrides) => ({
  tool: "zizmor",
  rule: "template-injection",
  file: ".github/workflows/x.yml",
  line: 10,
  message: "code injection via template expansion",
  key: "zizmor:template-injection:.github/workflows/x.yml:[]",
  ...overrides,
});

describe("shouldAudit", () => {
  for (const file of [
    ".github/workflows/push-checks.yml",
    ".github/actions/merge-main-and-install/action.yml",
    ".github/actionlint.yaml",
    ".github/jactionlint.yaml",
    ".github/pinact.yaml",
    ".github/dependabot.yml",
    "mise.toml",
    "mise.lock",
  ]) {
    it(`audits when the range changes ${file}`, () => {
      expect(shouldAudit({ force: false, files: [file] })).toBe(true);
    });
  }

  it("does not audit when the range only changes code outside the workflows", () => {
    expect(
      shouldAudit({
        force: false,
        files: ["backend/src/main.ts", ".github/scripts/patch-notes.mjs"],
      }),
    ).toBe(false);
  });

  it("audits without a reliable range and when forced (weekly run)", () => {
    expect(shouldAudit({ force: false, files: null })).toBe(true);
    expect(shouldAudit({ force: true, files: [] })).toBe(true);
  });
});

describe("zizmorFindings", () => {
  it("builds rule, relative file, 1-based line and key from each zizmor result", () => {
    const route = [
      { Key: "jobs" },
      { Key: "a" },
      { Key: "steps" },
      { Index: 1 },
    ];
    const [found] = zizmorFindings(
      [
        zizmorResult({
          ident: "template-injection",
          desc: "code injection via template expansion",
          path: "/tmp/base/.github/workflows/x.yml",
          route,
          row: 9,
        }),
      ],
      "/tmp/base",
    );

    expect(found).toEqual({
      tool: "zizmor",
      rule: "template-injection",
      file: ".github/workflows/x.yml",
      line: 10,
      message: "code injection via template expansion",
      key: `zizmor:template-injection:.github/workflows/x.yml:${JSON.stringify(route)}`,
    });
  });

  it("gives the same key to the same rule on the same step at the head and the merge-base", () => {
    const route = [{ Key: "jobs" }, { Key: "a" }];
    const [head] = zizmorFindings(
      [
        zizmorResult({
          ident: "x",
          path: ".github/workflows/x.yml",
          route,
          row: 3,
        }),
      ],
      process.cwd(),
    );
    const [base] = zizmorFindings(
      [
        zizmorResult({
          ident: "x",
          path: "/tmp/b/.github/workflows/x.yml",
          route,
          row: 40,
        }),
      ],
      "/tmp/b",
    );

    expect(head.key).toBe(base.key);
    expect(head.line).not.toBe(base.line);
  });
});

describe("pinactFindings", () => {
  it("keys each pinact result by the line text instead of the line number", () => {
    const content =
      "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n";
    const [found] = pinactFindings(
      sarif([
        sarifResult({
          ruleId: "parse-error",
          uri: "/tmp/b/.github/workflows/x.yml",
          line: 4,
          text: "action can't be pinned",
        }),
      ]),
      "/tmp/b",
      () => content,
    );

    expect(found).toEqual({
      tool: "pinact",
      rule: "parse-error",
      file: ".github/workflows/x.yml",
      line: 4,
      message: "action can't be pinned",
      key: "pinact:parse-error:.github/workflows/x.yml:- uses: actions/checkout@v4",
    });
  });
});

describe("classifyFindings", () => {
  it("marks every finding as new without a merge-base", () => {
    const head = [finding({ key: "a" }), finding({ key: "b" })];

    expect(classifyFindings(head, null)).toEqual({
      added: head,
      inherited: [],
    });
  });

  it("keeps the findings of the merge-base as inherited and the rest as new", () => {
    const old = finding({ key: "old" });
    const fresh = finding({ key: "new" });

    expect(classifyFindings([old, fresh], [finding({ key: "old" })])).toEqual({
      added: [fresh],
      inherited: [old],
    });
  });

  it("marks as new each repeat of a key beyond the times the merge-base has it", () => {
    const first = finding({ key: "k", line: 5 });
    const second = finding({ key: "k", line: 8 });
    const third = finding({ key: "k", line: 11 });

    expect(
      classifyFindings([first, second, third], [finding({ key: "k" })]),
    ).toEqual({ added: [second, third], inherited: [first] });
    expect(
      classifyFindings(
        [first, second],
        [finding({ key: "k" }), finding({ key: "k" })],
      ),
    ).toEqual({ added: [], inherited: [first, second] });
  });
});

describe("openAuditIssue", () => {
  it("returns the trimmed url of the first open issue with the audit label", () => {
    const calls = [];
    const url = openAuditIssue((args) => {
      calls.push(args);

      return `  ${ISSUE_URL}\n`;
    });

    expect(url).toBe(ISSUE_URL);
    expect(calls).toEqual([
      [
        "issue",
        "list",
        "--label",
        AUDIT_LABEL,
        "--state",
        "open",
        "--json",
        "url",
        "--jq",
        '.[0].url // ""',
      ],
    ]);
  });

  it("lets a failing gh throw to the caller", () => {
    expect(() =>
      openAuditIssue(() => {
        throw new Error("gh: not logged in");
      }),
    ).toThrow("gh: not logged in");
  });
});

describe("auditLog", () => {
  it("writes a single ✓ step without findings", () => {
    expect(
      stepLines(auditLog({ added: [], inherited: [], failures: [] })),
    ).toEqual([`✓ ${AUDIT_STEP} OK`]);
  });

  it("writes a ✗ step on a new finding, listing new and inherited ones with the issue link", () => {
    const log = auditLog({
      added: [finding({})],
      inherited: [
        finding({
          tool: "pinact",
          rule: "parse-error",
          line: 4,
          message: "pin",
        }),
      ],
      failures: [],
      issueUrl: ISSUE_URL,
    });

    expect(stepLines(log)).toEqual([`✗ ${AUDIT_STEP} failed`]);
    expect(log).toMatch(/^ {2}1 new finding in this change:$/mu);
    expect(log).toMatch(
      /^ {2}│ \.github\/workflows\/x\.yml:10 zizmor\/template-injection: code injection via template expansion$/mu,
    );
    expect(log).toMatch(
      new RegExp(
        `^ {2}1 finding already on main \\(issue: ${ISSUE_URL}\\):$`,
        "mu",
      ),
    );
    expect(log).toMatch(
      /^ {2}│ \.github\/workflows\/x\.yml:4 pinact\/parse-error: pin$/mu,
    );
  });

  it("writes a ⚠ step with the issue link when every finding is inherited", () => {
    const log = auditLog({
      added: [],
      inherited: [finding({}), finding({ key: "b" })],
      failures: [],
      issueUrl: ISSUE_URL,
    });
    const [step] = stepLines(log);

    expect(step).toBe(
      `⚠ ${AUDIT_STEP}: 2 findings already on main, none new (issue: ${ISSUE_URL})`,
    );
  });

  it("says the weekly run opens the issue when an inherited finding has none open", () => {
    const [step] = stepLines(
      auditLog({ added: [], inherited: [finding({})], failures: [] }),
    );

    expect(step).toBe(
      `⚠ ${AUDIT_STEP}: 1 finding already on main, none new (no open issue: the weekly run on main opens one)`,
    );
  });

  it("fails the audit with the indented output of a tool that did not return its format", () => {
    const log = auditLog({
      added: [],
      inherited: [],
      failures: [
        {
          name: "lint:workflows:zizmor:online",
          output: "✗ error that imitates a step\nboom",
        },
      ],
    });

    expect(stepLines(log)).toEqual([`✗ ${AUDIT_STEP} failed`]);
    expect(log).toMatch(/^ {2}lint:workflows:zizmor:online did not run:$/mu);
    expect(log).toMatch(/^ {2}│ ✗ error that imitates a step$/mu);
  });
});

describe("annotations", () => {
  it("annotates a new finding as an error and an inherited one as a warning, escaping the text", () => {
    const lines = annotations({
      added: [finding({ message: "a, b: 100%\nmais" })],
      inherited: [
        finding({
          tool: "pinact",
          rule: "parse-error",
          line: 4,
          message: "pin",
        }),
      ],
    });

    expect(lines).toEqual([
      "::error file=.github/workflows/x.yml,line=10,title=zizmor/template-injection::a, b: 100%25%0Amais",
      "::warning file=.github/workflows/x.yml,line=4,title=pinact/parse-error (already on main)::pin",
    ]);
  });
});

const FAKE_TOOL = `
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const [tool, ...args] = process.argv.slice(2);
if (process.env.FAKE_BROKEN === tool) {
  console.log("✗ broke");
  process.exit(1);
}
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
const lines = (file) =>
  readFileSync(file, "utf8").split("\\n").map((text, index) => ({ text, line: index + 1 }));

if (tool === "zizmor") {
  const out = walk(args[0]).flatMap((file) =>
    lines(file)
      .filter(({ text }) => text.includes("VULN-"))
      .map(({ text, line }) => {
        const ident = text.match(/VULN-([a-z]+)/)[1];
        return {
          ident,
          desc: ident + " desc",
          locations: [{
            symbolic: { key: { Local: { verbatim_path: file } }, route: { route: [{ Key: ident }] }, kind: "Primary" },
            concrete: { location: { start_point: { row: line - 1, column: 0 } } },
          }],
        };
      }),
  );
  console.log(JSON.stringify(out));
  process.exit(out.length > 0 ? 14 : 0);
}

const results = args.flatMap((file) =>
  lines(file)
    .filter(({ text }) => text.includes("UNPINNED"))
    .map(({ line }) => ({
      ruleId: "parse-error",
      message: { text: "action can't be pinned" },
      locations: [{ physicalLocation: { artifactLocation: { uri: file }, region: { startLine: line } } }],
    })),
);
console.log(JSON.stringify({ runs: [{ results }] }));
process.exit(results.length > 0 ? 1 : 0);
`;

const FAKE_GH = `
const args = process.argv.slice(2);
if (args[0] === "issue" && args[1] === "list") console.log(process.env.FAKE_ISSUE ?? "");
`;

let repo;

function git(...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function commit(file, content) {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), content);
  git("add", file);
  git("commit", "-qm", file);

  return git("rev-parse", "HEAD");
}

function run(env) {
  const output = join(repo, "github-output");
  writeFileSync(output, "");
  const bin = join(repo, "bin");
  const result = spawnSync("node", [SCRIPT], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      LOG_FILE: join(repo, "workflow-audit.log"),
      GITHUB_OUTPUT: output,
      ...env,
    },
  });

  return {
    ...result,
    log: readFileSync(join(repo, "workflow-audit.log"), "utf8"),
    outputs: Object.fromEntries(
      readFileSync(output, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("=")),
    ),
  };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "bcct-workflow-audit-"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(join(repo, "fake-tool.mjs"), FAKE_TOOL);
  mkdirSync(join(repo, "bin"));
  writeFileSync(join(repo, "bin", "gh"), `#!/usr/bin/env node\n${FAKE_GH}`, {
    mode: 0o755,
  });
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: {
        "lint:workflows:zizmor:online": "node fake-tool.mjs zizmor",
        "lint:workflows:pinact:online": "node fake-tool.mjs pinact",
      },
    }),
  );
  writeFileSync(
    join(repo, ".gitignore"),
    "bin\nworkflow-audit.log\ngithub-output\n",
  );
  git("add", ".");
  git("commit", "-qm", "base");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("workflow-audit (script)", () => {
  it("skips the tools and exits 0 with an empty log when the range changes no workflow", () => {
    const before = git("rev-parse", "HEAD");
    commit("backend/src/main.ts", "x\n");

    const result = run({ BEFORE: before });

    expect(result.status).toBe(0);
    expect(result.log).toBe("");
    expect(result.outputs).toEqual({ ran: "false", exit: "0" });
  });

  it("writes the ✓ step and exits 0 when a changed workflow has no finding", () => {
    const before = git("rev-parse", "HEAD");
    commit(".github/workflows/x.yml", "name: x\n");

    const result = run({ BEFORE: before });

    expect(result.status).toBe(0);
    expect(result.log).toBe(`✓ ${AUDIT_STEP} OK\n`);
    expect(result.outputs).toEqual({ ran: "true", exit: "0" });
  });

  it("fails with a ✗ step and error annotations on the zizmor and pinact findings the change brings", () => {
    const before = git("rev-parse", "HEAD");
    commit(
      ".github/workflows/x.yml",
      "name: x\n# VULN-injection\n      - uses: a/b@v1 # UNPINNED\n",
    );

    const result = run({ BEFORE: before });

    expect(result.status).toBe(1);
    expect(result.log).toMatch(new RegExp(`^✗ ${AUDIT_STEP} failed$`, "mu"));
    expect(result.log).toMatch(/^ {2}2 new findings in this change:$/mu);
    expect(result.stdout).toMatch(
      /^::error file=\.github\/workflows\/x\.yml,line=2,title=zizmor\/injection::injection desc$/mu,
    );
    expect(result.stdout).toMatch(
      /^::error file=\.github\/workflows\/x\.yml,line=3,title=pinact\/parse-error::action can't be pinned$/mu,
    );
    expect(result.outputs).toEqual({ ran: "true", exit: "1" });
  });

  it("warns with the open issue and exits 0 on a finding already on the merge-base", () => {
    commit(
      ".github/workflows/x.yml",
      "name: x\n# VULN-injection\n      - uses: a/b@v1 # UNPINNED\n",
    );
    const before = git("rev-parse", "HEAD");
    commit(
      ".github/workflows/x.yml",
      "name: x\non: push\n# VULN-injection\n      - uses: a/b@v1 # UNPINNED\n",
    );

    const result = run({ BEFORE: before, FAKE_ISSUE: ISSUE_URL });

    expect(result.status).toBe(0);
    expect(stepLines(result.log)).toEqual([
      `⚠ ${AUDIT_STEP}: 2 findings already on main, none new (issue: ${ISSUE_URL})`,
    ]);
    expect(result.stdout).toMatch(
      /^::warning file=\.github\/workflows\/x\.yml,line=3,/m,
    );
    expect(result.stdout).not.toMatch(/^::error/m);
    expect(result.outputs).toEqual({ ran: "true", exit: "0" });
  });

  it("ignores a finding only main gained after the merge-base of a pull request", () => {
    const base = git("rev-parse", "HEAD");
    commit(".github/workflows/main-only.yml", "# VULN-mainonly\n");
    const mainTip = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", "pr", base);
    commit(".github/workflows/x.yml", "name: x\n# VULN-injection\n");

    const result = run({ BEFORE: mainTip });

    expect(result.status).toBe(1);
    expect(result.log).toMatch(/^ {2}1 new finding in this change:$/mu);
    expect(result.log).not.toMatch(/mainonly/);
  });

  it("marks every finding as new on a forced run without a range", () => {
    commit(".github/workflows/x.yml", "# VULN-injection\n");
    commit("backend/src/main.ts", "x\n");

    const result = run({ BEFORE: "", FORCE: "true" });

    expect(result.status).toBe(1);
    expect(result.log).toMatch(/^ {2}1 new finding in this change:$/mu);
    expect(result.outputs).toEqual({ ran: "true", exit: "1" });
  });

  it("audits every finding as new on an unknown range", () => {
    commit(".github/workflows/x.yml", "# VULN-injection\n");

    const result = run({ BEFORE: "0".repeat(40) });

    expect(result.outputs.ran).toBe("true");
    expect(result.outputs.exit).toBe("1");
  });

  it("fails the audit when a tool prints output outside its format", () => {
    const before = git("rev-parse", "HEAD");
    commit(".github/workflows/x.yml", "name: x\n");

    const result = run({ BEFORE: before, FAKE_BROKEN: "zizmor" });

    expect(result.status).toBe(1);
    expect(result.log).toMatch(
      /^ {2}lint:workflows:zizmor:online did not run:$/mu,
    );
    expect(result.log).toMatch(/^ {2}│ ✗ broke$/mu);
  });
});
