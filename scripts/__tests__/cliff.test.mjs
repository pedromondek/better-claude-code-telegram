import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { miseEnv } from "../../.husky/__tests__/support/mise-env.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const MISE_EXEC = join(ROOT, "scripts", "mise-exec.sh");
const TOOL_TIMEOUT = 60_000;
const CONFIG = ["mise.toml", "mise.lock", "cliff.toml"];

let repo;

function git(...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function commit(subject, body = "") {
  writeFileSync(join(repo, "change.txt"), `${subject}\n${body}\n`);
  git("add", "change.txt");
  git("commit", "-qm", body === "" ? subject : `${subject}\n\n${body}`);
}

function cliff(...args) {
  const result = spawnSync("sh", [MISE_EXEC, "git-cliff", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...miseEnv(repo) },
  });

  expect({ status: result.status, stderr: result.stderr }).toMatchObject({
    status: 0,
  });

  return result.stdout.trim();
}

function released() {
  commit("🎉 init: start");
  git("tag", "v0.1.0");
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "bcct-cliff-"));

  for (const file of CONFIG) {
    copyFileSync(join(ROOT, file), join(repo, file));
  }

  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("cliff.toml", { timeout: TOOL_TIMEOUT }, () => {
  it("runs the git-cliff version pinned in mise.toml", () => {
    expect(cliff("--version")).toBe("git-cliff 2.14.2");
  });

  it("starts at 0.1.0 when there is no tag yet", () => {
    commit("✨ feat(rust): first feature");

    expect(cliff("--bumped-version")).toBe("v0.1.0");
  });

  it.each([
    ["✨ feat(rust): add a command", "v0.2.0"],
    ["🐛 fix(root): repair the hook", "v0.1.1"],
    ["⚡ perf(rust): speed up the hook", "v0.1.1"],
    ["🔐 security(rust): tighten the pairing", "v0.1.1"],
  ])("reads %s through the emoji and bumps to %s", (subject, bumped) => {
    released();
    commit(subject);

    expect(cliff("--bumped-version")).toBe(bumped);
  });

  it("keeps the version of the last tag when only maintenance came after it, so there is nothing to release", () => {
    released();
    commit("🔧 chore(root): bump a tool");
    commit("✅ test(rust): cover the parser");

    expect(cliff("--bumped-version")).toBe("v0.1.0");
  });

  it("keeps a breaking change on the minor while the version is 0.x", () => {
    released();
    commit("✨ feat(rust)!: rename the setup flags");

    expect(cliff("--bumped-version")).toBe("v0.2.0");
  });

  it("groups features and fixes in the notes, without the emoji, and leaves maintenance and fixups out", () => {
    released();
    commit("✨ feat(rust): add the update command");
    commit("🐛 fix(root): keep the shell line single");
    commit("🔧 chore(root): bump a tool");
    commit("✅ test(rust): cover the parser");
    commit("fixup! ✨ feat(rust): add the update command");

    const notes = cliff("--unreleased");

    expect(notes).toContain("### Features");
    expect(notes).toContain("- **rust:** Add the update command");
    expect(notes).toContain("### Bug fixes");
    expect(notes).toContain("- **root:** Keep the shell line single");
    expect(notes).not.toContain("bump a tool");
    expect(notes).not.toContain("cover the parser");
    expect(notes).not.toContain("fixup!");
    expect(notes).not.toContain("✨");
  });

  it("is the release:cliff npm script", () => {
    const scripts = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ).scripts;

    expect(scripts["release:cliff"]).toBe("sh scripts/mise-exec.sh git-cliff");
  });
});
