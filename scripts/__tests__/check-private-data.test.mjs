import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addedLines,
  findPrivateData,
  formatFindings,
  machinePathPattern,
  parseLocalPatterns,
} from "../check-private-data.mjs";

const SCRIPT = join(import.meta.dirname, "..", "check-private-data.mjs");
const USER = "octo-tester";
const HOME = `/home/${USER}`;
const AT = "@";
const PERSONAL_EMAIL = `someone${AT}mail.com`;

function diffOf(file, lines, start = 1) {
  return [
    `diff --git a/${file} b/${file}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${file}`,
    `@@ -0,0 +${start},${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

function scan({
  diff = "",
  files = [],
  identities = [],
  localPatterns = [],
} = {}) {
  return findPrivateData({
    diff,
    files,
    identities,
    localPatterns,
    username: USER,
    home: HOME,
  });
}

describe("addedLines", () => {
  it("returns every added line with its file and its line in the new version", () => {
    const diff = [
      "diff --git a/a.md b/a.md",
      "index 1111111..2222222 100644",
      "--- a/a.md",
      "+++ b/a.md",
      "@@ -3,0 +4,2 @@ heading",
      "+first",
      "+second",
      "@@ -10 +12 @@",
      "-old",
      "+new",
      String.raw`\ No newline at end of file`,
      diffOf("dir/b.txt", ["only"]),
    ].join("\n");

    expect(addedLines(diff)).toEqual([
      { file: "a.md", line: 4, text: "first" },
      { file: "a.md", line: 5, text: "second" },
      { file: "a.md", line: 12, text: "new" },
      { file: "dir/b.txt", line: 1, text: "only" },
    ]);
  });

  it("reads an added line that starts with ++ as content, not as a file header", () => {
    expect(addedLines(diffOf("notes.md", ["++ b/other.md"]))).toEqual([
      { file: "notes.md", line: 1, text: "++ b/other.md" },
    ]);
  });

  it("ignores a deleted file, which has no destination", () => {
    const diff = [
      "diff --git a/gone.md b/gone.md",
      "deleted file mode 100644",
      "--- a/gone.md",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
    ].join("\n");

    expect(addedLines(diff)).toEqual([]);
  });
});

describe("findPrivateData", () => {
  it("finds nothing in ordinary code", () => {
    const lines = [
      "export const chat = '123456:short';",
      "const bot = process.env.TELEGRAM_BOT_TOKEN;",
      'import { join } from "node:path";',
    ];

    expect(scan({ diff: diffOf("a.ts", lines) })).toEqual([]);
  });

  it("finds a personal e-mail and lets through the noreply and reserved domains", () => {
    const lines = [
      `author: ${PERSONAL_EMAIL}`,
      `36709376+someone${AT}users.noreply.github.com`,
      `noreply${AT}github.com is not noreply.github.com`,
      `test${AT}example.com, dev${AT}example.org, a${AT}b.example, x${AT}host.test`,
      `git${AT}github.com:owner/repo.git`,
      `"@types/node": "24.19.2", grammy${AT}1.46.0`,
    ];

    expect(scan({ diff: diffOf("README.md", lines) })).toEqual([
      { where: "README.md:1", kind: "personal e-mail" },
      { where: "README.md:3", kind: "personal e-mail" },
    ]);
  });

  it("finds paths of this machine, in Linux, macOS, Windows and WSL form, and the home itself", () => {
    const lines = [
      `${HOME}/projects/app`,
      `/Users/${USER}/Library`,
      `C:\\Users\\${USER}\\Desktop`,
      `c:/Users/${USER}/Desktop`,
      `/mnt/c/Users/${USER}/Documents`,
      `~ is ${HOME}`,
    ];

    expect(
      scan({ diff: diffOf("notes.md", lines) }).map(({ where }) => where),
    ).toEqual(lines.map((_, index) => `notes.md:${index + 1}`));
  });

  it("leaves alone a generic path and the home of another user", () => {
    const lines = [
      "cwd: /home/dev/my-project",
      `/home/${USER}-other/app`,
      "/Users/someone/Library",
      "/tmp/build",
    ];

    expect(scan({ diff: diffOf("a.test.mjs", lines) })).toEqual([]);
  });

  it("checks the home literally only when it has at least two folders", () => {
    expect(
      machinePathPattern({ username: USER, home: "/" }).test("/usr/bin"),
    ).toBe(false);
    expect(
      machinePathPattern({ username: USER, home: "/root" }).test("/root/x"),
    ).toBe(false);
    expect(
      machinePathPattern({ username: USER, home: "/var/lib/octo" }).test(
        "/var/lib/octo/x",
      ),
    ).toBe(true);
  });

  it("finds the terms of the local private list, ignoring case, in content, file names and the commit identity", () => {
    const localPatterns = parseLocalPatterns(
      "# my private terms\n\nAcme-Internal\n  side-gig  \n",
    );

    expect(
      scan({
        diff: diffOf("docs/x.md", [
          "Ported from ACME-INTERNAL",
          "nothing here",
        ]),
        files: ["docs/x.md", "docs/side-gig-notes.md"],
        identities: [
          ["author", "Dev <dev@side-gig.example>"],
          ["committer", "Dev <dev@users.noreply.github.com>"],
        ],
        localPatterns,
      }),
    ).toEqual([
      {
        where: "docs/side-gig-notes.md",
        kind: "term from the local private list in the file name",
      },
      { where: "docs/x.md:1", kind: "term from the local private list" },
      { where: "commit author", kind: "term from the local private list" },
    ]);
  });

  it("finds a path of this machine in a file name", () => {
    expect(scan({ files: [`backup${HOME}/notes.md`] })).toEqual([
      {
        where: `backup${HOME}/notes.md`,
        kind: "path of this machine in the file name",
      },
    ]);
  });

  it("finds a lock entry resolved outside the public npm registry, only in package-lock.json", () => {
    const lines = [
      '"resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz",',
      '"resolved": "https://npm.internal.example/b/-/b-1.0.0.tgz",',
      '"resolved": "git+ssh://git@github.com/owner/c.git#abc",',
    ];

    expect(scan({ diff: diffOf("package-lock.json", lines) })).toEqual([
      {
        where: "package-lock.json:2",
        kind: "lock entry resolved outside the public npm registry",
      },
      {
        where: "package-lock.json:3",
        kind: "lock entry resolved outside the public npm registry",
      },
    ]);
    expect(scan({ diff: diffOf("docs/lock.md", [lines[1]]) })).toEqual([]);
  });
});

describe("formatFindings", () => {
  it("lists where and what, never the value, and says where the local list lives", () => {
    const text = formatFindings(
      [{ where: "a.ts:3", kind: "personal e-mail" }],
      ".git/info/private-data",
    );

    expect(text).toContain("  - a.ts:3: personal e-mail");
    expect(text).toContain(".git/info/private-data");
  });
});

describe("check-private-data.mjs", () => {
  let repo;

  function git(...args) {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  }

  function stage(file, content) {
    mkdirSync(join(repo, file, ".."), { recursive: true });
    writeFileSync(join(repo, file), content);
    git("add", file);
  }

  function run() {
    return spawnSync(process.execPath, [SCRIPT], {
      cwd: repo,
      encoding: "utf8",
    });
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bcct-private-data-"));
    git("init", "-q");
    git("config", "user.email", `dev${AT}users.noreply.github.com`);
    git("config", "user.name", "dev");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("exits 0 without output when the stage is clean", () => {
    stage("src/a.ts", "export const a = 1;\n");

    const result = run();

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("exits 1 and lists the findings of the stage, with the line in the file", () => {
    stage(
      "src/a.ts",
      `export const a = 1;\nconst author = "${PERSONAL_EMAIL}";\n`,
    );

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/a.ts:2: personal e-mail");
    expect(result.stderr).not.toContain(PERSONAL_EMAIL);
  });

  it("scans a stage larger than the default 1 MiB output buffer of spawnSync", () => {
    const filler = `${"x".repeat(63)}\n`.repeat(20_000);
    stage("fixture.json", `${filler}${PERSONAL_EMAIL}\n`);

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fixture.json:20001: personal e-mail");
  });

  it("checks only the staged version, not the change outside the stage", () => {
    stage("notes.md", "clean\n");
    writeFileSync(join(repo, "notes.md"), `clean\n${PERSONAL_EMAIL}\n`);

    expect(run().status).toBe(0);
  });

  it("finds the home of this machine", () => {
    stage("notes.md", `log at ${homedir()}/x.log\n`);

    expect(run().stderr).toContain("notes.md:1: path of this machine");
  });

  it("reads the local private list from .git/info/private-data", () => {
    writeFileSync(
      join(repo, ".git", "info", "private-data"),
      "acme-internal\n",
    );
    stage("README.md", "Built for Acme-Internal\n");

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "README.md:1: term from the local private list",
    );
  });

  it("checks the author of the commit against the local private list", () => {
    writeFileSync(
      join(repo, ".git", "info", "private-data"),
      "personal-mail\n",
    );
    git("config", "user.email", `dev${AT}personal-mail.example`);
    stage("README.md", "hello\n");

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "commit author: term from the local private list",
    );
  });

  it("names a renamed file by its new path", () => {
    writeFileSync(
      join(repo, ".git", "info", "private-data"),
      "acme-internal\n",
    );
    stage("old.md", "hello\n");
    git("commit", "-qm", "base");
    git("mv", "old.md", "acme-internal.md");

    expect(run().stderr).toContain(
      "acme-internal.md: term from the local private list in the file name",
    );
  });

  it("does not check a deleted file", () => {
    stage("old.md", `${PERSONAL_EMAIL}\n`);
    git("commit", "-qm", "base");
    git("rm", "-q", "old.md");

    expect(run().status).toBe(0);
  });
});
