import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import czConfig from "../../cz.config.mjs";
import {
  COMMIT_HEADER_MAX_LENGTH,
  commitTypes,
  validateCommitMessage,
} from "../lib/validate-commit-msg.mjs";
import { HUSKY_HOOK_ARGS } from "./support/husky-hook.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const HOOK = join(ROOT, ".husky", "commit-msg");
const HOOK_TIMEOUT = 30_000;

const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
);

const header = (length) => {
  const prefix = "🔧 chore(telegram): ";

  return prefix + "a".repeat(length - [...prefix].length);
};

let dir;

function runHook(message) {
  const file = join(dir, "COMMIT_EDITMSG");

  writeFileSync(file, message);

  return spawnSync("sh", [...HUSKY_HOOK_ARGS, HOOK, file], {
    encoding: "utf8",
    env,
  });
}

function git(...args) {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8", env });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bcct-commit-msg-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("commitTypes", () => {
  it("joins the emoji and the value of every type in cz.config.mjs", () => {
    expect(commitTypes(czConfig)).toContain("✨ feat");
    expect(commitTypes(czConfig)).toContain("🔧 chore");
    expect(commitTypes(czConfig)).toHaveLength(czConfig.types.length);
  });
});

describe("validateCommitMessage", () => {
  it("accepts type(scope): subject with every type of cz.config.mjs", () => {
    const rejected = commitTypes(czConfig).filter(
      (type) =>
        validateCommitMessage(`${type}(root): subject`, czConfig).length > 0,
    );

    expect(rejected).toEqual([]);
  });

  it("accepts a message without scope, as czg writes it when the scope is empty", () => {
    expect(validateCommitMessage("✨ feat: new screen", czConfig)).toEqual([]);
  });

  it("accepts a scope outside the list when cz.config.mjs allows custom scopes", () => {
    expect(
      validateCommitMessage("🔧 chore(claude): tweak", {
        ...czConfig,
        allowCustomScopes: true,
      }),
    ).toEqual([]);
  });

  it("refuses a scope outside the list when cz.config.mjs does not allow custom scopes", () => {
    expect(
      validateCommitMessage("🔧 chore(claude): tweak", {
        ...czConfig,
        allowCustomScopes: false,
      }).join("\n"),
    ).toMatch(/scope "claude"/);
  });

  it("refuses a type that is not in the list, including one without the emoji", () => {
    const accepted = [
      "chore(root): subject",
      "🔧 chores(root): subject",
      "🐛 chore(root): subject",
    ].filter(
      (message) =>
        !/type/.test(validateCommitMessage(message, czConfig).join("\n")),
    );

    expect(accepted).toEqual([]);
  });

  it("refuses a header outside the type(scope): subject format", () => {
    const accepted = [
      "🔧 chore(root) subject",
      "🔧 chore(root):subject",
      "🔧 chore(): subject",
      "🔧 chore(a b): subject",
      "🔧 chore(root): ",
      "🔧 chore(root):  subject",
      "update the pre-push",
    ].filter(
      (message) =>
        !/format/.test(validateCommitMessage(message, czConfig).join("\n")),
    );

    expect(accepted).toEqual([]);
  });

  it("counts the header by character: accepts the limit and refuses one above", () => {
    expect(COMMIT_HEADER_MAX_LENGTH).toBe(100);
    expect(
      validateCommitMessage(header(COMMIT_HEADER_MAX_LENGTH), czConfig),
    ).toEqual([]);
    expect(
      validateCommitMessage(
        header(COMMIT_HEADER_MAX_LENGTH + 1),
        czConfig,
      ).join("\n"),
    ).toMatch(/101 characters/);
  });

  it("lists every problem at once", () => {
    const problems = validateCommitMessage(
      `chore(root): ${"a".repeat(100)}`,
      czConfig,
    );

    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toMatch(/type/);
    expect(problems.join("\n")).toMatch(/characters/);
  });

  it("reads the header on the first line that is neither a comment nor empty", () => {
    expect(
      validateCommitMessage(
        "\n   \n# Please enter the commit message\n🔧 chore(root): subject\n\nlong body ".concat(
          "b".repeat(200),
          "\n# comment\n",
        ),
        czConfig,
      ),
    ).toEqual([]);
  });

  it("lets through the messages git writes itself (merge, revert, reapply, fixup, squash, amend)", () => {
    const refused = [
      "Merge branch 'main' into 0001-fix-chatting",
      "Merge remote-tracking branch 'origin/main'",
      'Revert "🔧 chore(root): subject"',
      'Reapply "Merge pull request #35 from someone/0035-branch"',
      "fixup! 🔧 chore(root): subject",
      "squash! 🔧 chore(root): subject",
      "amend! 🔧 chore(root): subject",
    ].filter((message) => validateCommitMessage(message, czConfig).length > 0);

    expect(refused).toEqual([]);
  });

  it("accepts the closing keyword on its own line and Refs anywhere", () => {
    expect(
      validateCommitMessage(
        "✨ feat(root): key\n\nExplains why; see Refs #45.\n\nCloses #44\nfixes: #46",
        czConfig,
      ),
    ).toEqual([]);
  });

  it("refuses the closing keyword in the middle of the text, which GitHub also reads and uses to close the issue", () => {
    const problems = validateCommitMessage(
      "🐛 fix(root): repair the login\n\nThe bug goes away after the deploy; fix #12 for good.",
      czConfig,
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /"fix #12" in the middle of the text closes issue #12/,
    );
    expect(problems[0]).toMatch(/the line "Closes #12" on its own/);
    expect(problems[0]).toMatch(/"Refs #12"/);
  });

  it("refuses the closing keyword in the header", () => {
    expect(
      validateCommitMessage(
        "🐛 fix(root): fixes #12 in the login",
        czConfig,
      ).join("\n"),
    ).toMatch(/"fixes #12" in the middle of the text/);
  });

  it("ignores git comments and the diff below the scissors (commit -v)", () => {
    expect(
      validateCommitMessage(
        [
          "✨ feat(root): key",
          "",
          "# Please, fix #12 does not count here",
          "# ------------------------ >8 ------------------------",
          "+ diff text with fix #13",
        ].join("\n"),
        czConfig,
      ),
    ).toEqual([]);
  });

  it("refuses an empty message", () => {
    expect(
      validateCommitMessage("\n# only a comment\n", czConfig).join("\n"),
    ).toMatch(/empty/);
  });
});

describe(".husky/commit-msg", { timeout: HOOK_TIMEOUT }, () => {
  it("exits 0 with no output for a valid message", () => {
    const result = runHook("🔧 chore(root): subject\n");

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 1 and explains the problem, the accepted types and an example", () => {
    const result = runHook("chore(root): subject\n");

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/commit-msg/);
    expect(result.stderr).toMatch(/"chore"/);
    expect(result.stderr).toMatch(/🔧 chore/);
    expect(result.stderr).toMatch(/type\(scope\): subject/);
  });

  it("blocks git commit with a message outside the format and lets the valid one through", () => {
    const hooks = join(dir, "hooks");

    mkdirSync(hooks);
    writeFileSync(
      join(hooks, "commit-msg"),
      `#!/bin/sh\nexec sh "${HOOK}" "$1"\n`,
      { mode: 0o755 },
    );
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    git("config", "core.hooksPath", hooks);

    const rejected = git(
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "update the pre-push",
    );
    const accepted = git(
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "🔧 chore(root): update the pre-push",
    );

    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toMatch(/format/);
    expect(accepted.stderr).toBe("");
    expect(accepted.status).toBe(0);
    expect(git("log", "--format=%s").stdout).toBe(
      "🔧 chore(root): update the pre-push\n",
    );
  });
});
