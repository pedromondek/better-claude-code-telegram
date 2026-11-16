import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  UPSTREAM_CHANGES,
  UPSTREAM_COMMIT,
  UPSTREAM_LABEL,
  UPSTREAM_PATH,
  UPSTREAM_REPOSITORY,
  UPSTREAM_VERSION,
} from "../upstream.constants.mjs";
import { changedPaths, run } from "../watch-upstream.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const BASE = UPSTREAM_COMMIT;
const HEAD = "a".repeat(40);
const LATER = "b".repeat(40);
const COMPARE = (from, to) =>
  `https://github.com/${UPSTREAM_REPOSITORY}/compare/${from.slice(0, 7)}...${to.slice(0, 7)}`;

function fakeGithub({
  version = "0.0.8",
  head = HEAD,
  commits = [
    { sha: HEAD, headline: "fix(telegram): v0.0.8 polling" },
    { sha: BASE, headline: "fix(telegram): v0.0.7 reliability rollup" },
  ],
  files = ["server.ts", ".claude-plugin/plugin.json"],
  issue = null,
} = {}) {
  const calls = [];
  const github = {
    upstreamPlugin: () => ({ version, head }),
    upstreamCommits: () => commits,
    folderFiles: (commit) => {
      calls.push(["folderFiles", commit]);
      return new Map([
        ["ACCESS.md", "same"],
        ...files.map((file) => [file, commit === head ? "new" : "old"]),
      ]);
    },
    openIssue: () => issue,
    ensureLabel: () => calls.push(["ensureLabel"]),
    createIssue: (created) => {
      calls.push(["createIssue", created]);
      return 31;
    },
    comment: (number, body) => calls.push(["comment", number, body]),
  };

  return { github, calls };
}

function watchWith({ env = {}, github: options } = {}) {
  const { github, calls } = fakeGithub(options);
  const out = [];
  const err = [];
  const code = run(env, {
    github,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

  return { code, out, err, calls };
}

const writes = (calls) =>
  calls.filter(([name]) => ["createIssue", "comment"].includes(name));

describe("changedPaths", () => {
  it("lists in order the files of the folder that changed, were added or were removed between two commits", () => {
    const before = new Map([
      ["server.ts", "1"],
      ["ACCESS.md", "2"],
      ["old.md", "3"],
    ]);
    const after = new Map([
      ["server.ts", "9"],
      ["ACCESS.md", "2"],
      ["new.md", "4"],
    ]);

    expect(changedPaths(before, after)).toEqual([
      "new.md",
      "old.md",
      "server.ts",
    ]);
  });

  it("finds no change between the same files", () => {
    const files = new Map([["server.ts", "1"]]);

    expect(changedPaths(files, new Map(files))).toEqual([]);
  });
});

describe("upstream:watch › the same version", () => {
  it("does nothing while the official plugin keeps the version the copy came from", () => {
    const { code, out, calls } = watchWith({
      github: { version: UPSTREAM_VERSION, head: LATER },
    });

    expect(code).toBe(0);
    expect(out).toEqual([
      `✓ the official plugin is still at ${UPSTREAM_VERSION}`,
    ]);
    expect(calls).toEqual([]);
  });
});

describe("upstream:watch › a new version", () => {
  it("opens the issue with the new version, the commits since the base, the files changed and the compare link", () => {
    const { code, out, calls } = watchWith();
    const [, created] = calls.find(([name]) => name === "createIssue");

    expect(code).toBe(0);
    expect(
      calls
        .map(([name]) => name)
        .filter((name) => ["ensureLabel", "createIssue"].includes(name)),
    ).toEqual(["ensureLabel", "createIssue"]);
    expect(calls).toContainEqual(["folderFiles", BASE]);
    expect(calls).toContainEqual(["folderFiles", HEAD]);
    expect(created).toEqual({
      title: `The official Telegram plugin moved past ${UPSTREAM_VERSION} (1e96c6b → aaaaaaa)`,
      label: UPSTREAM_LABEL,
      body: [
        `Version: ${UPSTREAM_VERSION} → 0.0.8`,
        "",
        "Commits since 1e96c6b:",
        "- aaaaaaa fix(telegram): v0.0.8 polling",
        "",
        "Files changed: .claude-plugin/plugin.json, server.ts",
        "",
        `Compare: ${COMPARE(BASE, HEAD)}`,
        "",
        "Adopting it means updating plugins/telegram, NOTICE and scripts/upstream.constants.mjs together.",
        "",
        `<!-- upstream-head: ${HEAD} -->`,
      ].join("\n"),
    });
    expect(out).toEqual([
      "! the official plugin moved to 0.0.8 (aaaaaaa): opened #31",
    ]);
  });

  it("lists every commit when the base is no longer among the latest ones", () => {
    const { calls } = watchWith({
      github: {
        commits: [
          { sha: HEAD, headline: "two" },
          { sha: LATER, headline: "one" },
        ],
      },
    });
    const [, created] = calls.find(([name]) => name === "createIssue");

    expect(created.body).toContain("- aaaaaaa two\n- bbbbbbb one");
  });

  it("says no file changed under the plugin folder when the compare finds none", () => {
    const { calls } = watchWith({ github: { files: [] } });
    const [, created] = calls.find(([name]) => name === "createIssue");

    expect(created.body).toContain("Files changed: none under the folder");
  });

  it("comments the open issue with only what came after the head it reported last", () => {
    const issue = {
      number: 31,
      texts: [
        `first report\n<!-- upstream-head: ${HEAD} -->`,
        "a human comment",
      ],
    };
    const { code, out, calls } = watchWith({
      github: {
        version: "0.0.9",
        head: LATER,
        commits: [
          { sha: LATER, headline: "fix(telegram): v0.0.9" },
          { sha: HEAD, headline: "fix(telegram): v0.0.8 polling" },
          { sha: BASE, headline: "fix(telegram): v0.0.7 reliability rollup" },
        ],
        issue,
      },
    });

    expect(code).toBe(0);
    expect(calls.some(([name]) => name === "createIssue")).toBe(false);
    expect(calls).toContainEqual(["folderFiles", HEAD]);
    expect(calls).toContainEqual(["folderFiles", LATER]);
    expect(writes(calls)).toEqual([
      [
        "comment",
        31,
        [
          "The official plugin moved again, to 0.0.9 (aaaaaaa → bbbbbbb).",
          "",
          "Commits since aaaaaaa:",
          "- bbbbbbb fix(telegram): v0.0.9",
          "",
          "Files changed: .claude-plugin/plugin.json, server.ts",
          "",
          `Compare: ${COMPARE(HEAD, LATER)}`,
          "",
          `<!-- upstream-head: ${LATER} -->`,
        ].join("\n"),
      ],
    ]);
    expect(out).toEqual([
      "! the official plugin moved to 0.0.9 (bbbbbbb): commented on #31",
    ]);
  });

  it("writes nothing when the open issue already reported the current head", () => {
    const { code, out, calls } = watchWith({
      github: {
        issue: {
          number: 31,
          texts: [`report\n<!-- upstream-head: ${HEAD} -->`],
        },
      },
    });

    expect(code).toBe(0);
    expect(writes(calls)).toEqual([]);
    expect(out).toEqual([
      "- the official plugin at 0.0.8 (aaaaaaa) is already in #31",
    ]);
  });

  it("only prints the issue on a dry run, writing nothing on GitHub", () => {
    const { code, out, calls } = watchWith({ env: { DRY_RUN: "1" } });

    expect(code).toBe(0);
    expect(calls.filter(([name]) => name !== "folderFiles")).toEqual([]);
    expect(out[0]).toBe(
      `Would open: The official Telegram plugin moved past ${UPSTREAM_VERSION} (1e96c6b → aaaaaaa)`,
    );
    expect(out.join("\n")).toContain(`Compare: ${COMPARE(BASE, HEAD)}`);
  });

  it("reports the error of GitHub and fails the run", () => {
    const { github } = fakeGithub();
    const err = [];
    const code = run(
      {},
      {
        github: {
          ...github,
          upstreamPlugin: () => {
            throw new Error("HTTP 502: Bad Gateway");
          },
        },
        out: () => {},
        err: (line) => err.push(line),
      },
    );

    expect(code).toBe(1);
    expect(err).toEqual(["✗ HTTP 502: Bad Gateway"]);
  });
});

describe("upstream.constants.mjs", () => {
  it("names the upstream that NOTICE credits, at the version the copy came from", () => {
    const notice = readFileSync(join(ROOT, "NOTICE"), "utf8").replaceAll(
      "\n",
      " ",
    );

    expect(UPSTREAM_REPOSITORY).toBe("anthropics/claude-plugins-official");
    expect(UPSTREAM_PATH).toBe("external_plugins/telegram");
    expect(UPSTREAM_VERSION).toBe("0.0.7");
    expect(UPSTREAM_COMMIT).toBe("1e96c6b0a0f06cad576086243f3d06397c4ddf44");
    expect(notice).toContain(`(https://github.com/${UPSTREAM_REPOSITORY},`);
    expect(notice).toContain(` ${UPSTREAM_PATH}),`);
    expect(notice).toContain(`upstream version ${UPSTREAM_VERSION},`);
  });

  it("lists every file of the copy that differs from the upstream base, and NOTICE names each one", () => {
    const notice = readFileSync(join(ROOT, "NOTICE"), "utf8").replaceAll(
      "\n",
      " ",
    );

    expect(UPSTREAM_CHANGES).toEqual([
      ".claude-plugin/plugin.json",
      "bun.lock",
      "package.json",
      "server.ts",
      "skills/channel-guide/",
      "skills/configure/SKILL.md",
    ]);
    expect(
      UPSTREAM_CHANGES.filter(
        (file) => !notice.includes(`plugins/telegram/${file}`),
      ),
    ).toEqual([]);
    expect(notice).toContain("with five changes:");
  });

  it("is the upstream:watch npm script", () => {
    const { scripts } = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    );

    expect(scripts["upstream:watch"]).toBe("node scripts/watch-upstream.mjs");
  });
});
