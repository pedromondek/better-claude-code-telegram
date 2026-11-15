import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { advisoriesOf, run } from "../audit-plugin.mjs";

const ROOT = join(import.meta.dirname, "..", "..");

const advisory = (id, severity, title = `advisory ${id}`) => ({
  id,
  url: `https://github.com/advisories/GHSA-${id}`,
  title,
  severity,
  vulnerable_versions: "<9.9.9",
});

const REPORT = {
  "proxy-addr": [advisory(3, "critical", "IP spoofing")],
  "fast-uri": [advisory(2, "high", "host confusion"), advisory(5, "low")],
  "@hono/node-server": [advisory(4, "moderate")],
};

function fakes({ report = REPORT, issue = null, fails = false } = {}) {
  const calls = [];
  const bun = {
    audit: () => {
      if (fails) {
        throw new Error("bun audit did not answer with a report");
      }
      return report;
    },
  };
  const github = {
    openIssue: () => issue,
    ensureLabel: () => calls.push(["ensureLabel"]),
    createIssue: (created) => {
      calls.push(["createIssue", created]);
      return 40;
    },
    comment: (number, body) => calls.push(["comment", number, body]),
  };

  return { bun, github, calls };
}

function auditWith({ args = [], env = {}, ...options } = {}) {
  const { bun, github, calls } = fakes(options);
  const out = [];
  const err = [];
  const code = run(args, {
    env,
    bun,
    github,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

  return { code, out, err, calls };
}

const FINDINGS = [
  "✗ fast-uri high: host confusion - https://github.com/advisories/GHSA-2",
  "✗ proxy-addr critical: IP spoofing - https://github.com/advisories/GHSA-3",
];

describe("advisoriesOf", () => {
  it("keeps only the high and critical advisories of the bun audit report, in the order of the package names", () => {
    expect(advisoriesOf(REPORT)).toEqual([
      {
        name: "fast-uri",
        id: 2,
        severity: "high",
        title: "host confusion",
        url: "https://github.com/advisories/GHSA-2",
      },
      {
        name: "proxy-addr",
        id: 3,
        severity: "critical",
        title: "IP spoofing",
        url: "https://github.com/advisories/GHSA-3",
      },
    ]);
  });

  it("finds nothing in a report without advisories", () => {
    expect(advisoriesOf({})).toEqual([]);
  });
});

describe("audit:plugin", () => {
  it("passes while no dependency of the telegram plugin has a high or critical advisory", () => {
    const { code, out, calls } = auditWith({
      report: { "fast-uri": [advisory(5, "low")] },
    });

    expect(code).toBe(0);
    expect(out).toEqual([
      "✓ no high or critical advisory in the dependencies of the telegram plugin",
    ]);
    expect(calls).toEqual([]);
  });

  it("fails naming each high or critical advisory, without touching GitHub", () => {
    const { code, err, calls } = auditWith();

    expect(code).toBe(1);
    expect(err).toEqual(FINDINGS);
    expect(calls).toEqual([]);
  });

  it("fails when bun audit gives no report, since an unchecked lock is not a clean one", () => {
    const { code, err } = auditWith({ fails: true });

    expect(code).toBe(1);
    expect(err).toEqual(["✗ bun audit did not answer with a report"]);
  });

  it("takes no argument besides --issue", () => {
    expect(auditWith({ args: ["--fix"] })).toMatchObject({
      code: 2,
      err: ["usage: npm run audit:plugin [-- --issue]"],
    });
  });
});

describe("audit:plugin:issue", () => {
  it("opens the issue labeled security with every advisory and fails the run", () => {
    const { code, err, calls } = auditWith({ args: ["--issue"] });
    const [, created] = calls.find(([name]) => name === "createIssue");

    expect(code).toBe(1);
    expect(err).toEqual(FINDINGS);
    expect(calls.map(([name]) => name)).toEqual(["ensureLabel", "createIssue"]);
    expect(created).toEqual({
      title:
        "Dependencies of the telegram plugin with high or critical advisories",
      label: "security",
      body: [
        "`bun audit` found these advisories in plugins/telegram/bun.lock:",
        "",
        "- fast-uri, high: host confusion (https://github.com/advisories/GHSA-2)",
        "- proxy-addr, critical: IP spoofing (https://github.com/advisories/GHSA-3)",
        "",
        "Fixing it means resolving plugins/telegram/bun.lock again within the ranges of plugins/telegram/package.json, with the minimum release age of 7 days, until npm run audit:plugin passes.",
        "",
        "<!-- advisory: 2 -->",
        "<!-- advisory: 3 -->",
      ].join("\n"),
    });
  });

  it("comments the open issue with only the advisories it did not list yet", () => {
    const { calls } = auditWith({
      args: ["--issue"],
      issue: { number: 40, texts: ["report\n<!-- advisory: 2 -->"] },
    });

    expect(calls.filter(([name]) => name !== "ensureLabel")).toEqual([
      [
        "comment",
        40,
        [
          "`bun audit` found new advisories:",
          "",
          "- proxy-addr, critical: IP spoofing (https://github.com/advisories/GHSA-3)",
          "",
          "<!-- advisory: 3 -->",
        ].join("\n"),
      ],
    ]);
  });

  it("writes nothing when the open issue already lists every advisory, and still fails the run", () => {
    const { code, out, calls } = auditWith({
      args: ["--issue"],
      issue: {
        number: 40,
        texts: ["<!-- advisory: 2 -->", "<!-- advisory: 3 -->"],
      },
    });

    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(out).toEqual(["- every advisory is already in #40"]);
  });

  it("only prints the issue on a dry run", () => {
    const { calls, out } = auditWith({
      args: ["--issue"],
      env: { DRY_RUN: "1" },
    });

    expect(calls).toEqual([]);
    expect(out[0]).toBe(
      "Would open: Dependencies of the telegram plugin with high or critical advisories",
    );
  });

  it("opens nothing while the audit is clean", () => {
    const { code, calls } = auditWith({ args: ["--issue"], report: {} });

    expect(code).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("audit-plugin scripts", () => {
  it("are the audit:plugin and audit:plugin:issue npm scripts", () => {
    const { scripts } = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    );

    expect(scripts["audit:plugin"]).toBe("node scripts/audit-plugin.mjs");
    expect(scripts["audit:plugin:issue"]).toBe(
      "node scripts/audit-plugin.mjs --issue",
    );
  });
});
