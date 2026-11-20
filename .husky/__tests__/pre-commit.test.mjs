import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { miseEnv } from "./support/mise-env.mjs";
import {
  OLD_NODE_MESSAGE,
  SYSTEM_PATH,
  oldNodeFolder,
} from "./support/old-node.mjs";
import { MISSPELLED, TYPOS_REPORT } from "./support/typo-fixtures.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const COPIED = [
  ".husky/pre-commit",
  ".husky/lib/node-env.sh",
  ".husky/lib/explain-lint-staged-failure.mjs",
  "scripts/check-private-data.mjs",
  "scripts/require-node.cjs",
  "scripts/node-version.cjs",
  "package.json",
  "scripts/check-lockfile-sync.mjs",
  ".lockfile-lintrc.json",
  "scripts/mise-exec.sh",
  "lint-staged.config.mjs",
  ".prettierrc.json",
  ".secretlintrc.json",
  "_typos.toml",
  "mise.toml",
  "mise.lock",
];
const ROOT_MANIFEST = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
);
const AT = "@";
const COMMIT_TIMEOUT = 60_000;
const UNALIGNED_TABLE = "| a | b |\n| - | - |\n| longer cell | x |\n";
const ALIGNED_TABLE =
  "| a           | b   |\n| ----------- | --- |\n| longer cell | x   |\n";

let repo;

function git(...args) {
  return spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...miseEnv(repo) },
  });
}

function stage(file, content) {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), content);
  git("add", file);
}

function commit(message) {
  return git("commit", "-q", "-m", message);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "bcct-pre-commit-"));

  for (const file of COPIED) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    copyFileSync(join(ROOT, file), join(repo, file));
  }

  symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
  mkdirSync(join(repo, "hooks"));
  writeFileSync(
    join(repo, "hooks", "pre-commit"),
    `#!/bin/sh\nexport PATH="${join(ROOT, "node_modules", ".bin")}:$PATH"\nexec sh -e "${join(repo, ".husky", "pre-commit")}"\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(repo, ".gitignore"), "node_modules\nhooks\n");
  git("init", "-q");
  git("config", "user.email", "dev@users.noreply.github.com");
  git("config", "user.name", "dev");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("config", "core.hooksPath", join(repo, "hooks"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe(".husky/pre-commit", { timeout: COMMIT_TIMEOUT }, () => {
  it("blocks a commit with a secret in the stage through secretlint, masks it and commits nothing", () => {
    const token = `npm_${"d".repeat(36)}`;
    stage("notes.md", `//registry.npmjs.org/:_authToken=${token}\n`);

    const result = commit("add notes");
    const output = result.stdout + result.stderr;

    expect(result.status).toBe(1);
    expect(output).toContain("secretlint");
    expect(output).toContain("NPM_ACCESS_TOKEN");
    expect(output).not.toContain(token);
    expect(git("log", "--format=%s").stdout).toBe("base\n");
  });

  it("blocks a commit with a typo through typos run by mise", () => {
    stage("notes.md", `Call the ${MISSPELLED} function.\n`);

    const result = commit("add notes");

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain(TYPOS_REPORT);
    expect(git("log", "--format=%s").stdout).toBe("base\n");
  });

  it("blocks a commit whose package.json and lock are out of sync", () => {
    const manifest = {
      name: "probe",
      version: "1.0.0",
      engines: ROOT_MANIFEST.engines,
      scripts: {
        "lint:lockfile":
          "node scripts/check-lockfile-sync.mjs && lockfile-lint",
      },
      devDependencies: { "left-pad": "1.3.0" },
    };
    stage("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
    stage(
      "package-lock.json",
      `${JSON.stringify(
        {
          name: "probe",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": {
              name: "probe",
              version: "1.0.0",
              devDependencies: { "left-pad": "1.2.0" },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = commit("bump left-pad");

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      'devDependencies.left-pad: package.json "1.3.0" × package-lock.json "1.2.0"',
    );
  });

  it("blocks a commit with private data in the stage before lint-staged runs", () => {
    stage("notes.md", `contact: someone${AT}mail.com\n`);

    const result = commit("add notes");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("notes.md:1: personal e-mail");
    expect(result.stdout + result.stderr).not.toContain("secretlint");
  });

  it("blocks a commit whose author is in the local private list", () => {
    writeFileSync(
      join(repo, ".git", "info", "private-data"),
      "personal-mail\n",
    );
    git("config", "user.email", "dev@personal-mail.example");
    stage("notes.md", ALIGNED_TABLE);

    const result = commit("add notes");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("commit author");
  });

  it("stops the commit with the Node version message when the node of the PATH is too old", () => {
    writeFileSync(
      join(repo, "hooks", "pre-commit"),
      "#!/bin/sh\nexec sh -e .husky/pre-commit\n",
      { mode: 0o755 },
    );
    stage("notes.md", ALIGNED_TABLE);

    const result = spawnSync("git", ["commit", "-q", "-m", "add notes"], {
      cwd: repo,
      encoding: "utf8",
      env: {
        HOME: process.env.HOME,
        PATH: `${oldNodeFolder(repo)}:${SYSTEM_PATH}`,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(OLD_NODE_MESSAGE);
    expect(git("log", "--format=%s").stdout).toBe("base\n");
  });

  it("lets a clean commit through and commits what lint-staged formatted", () => {
    stage("notes.md", UNALIGNED_TABLE);

    const result = commit("add notes");

    expect(result.status).toBe(0);
    expect(git("show", "HEAD:notes.md").stdout).toBe(ALIGNED_TABLE);
  });
});
