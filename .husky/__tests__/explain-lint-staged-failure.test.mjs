import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, ".husky", "lib", "explain-lint-staged-failure.mjs");

const TOOL_TIMEOUT = 20_000;
const UNALIGNED_TABLE = "| a | b |\n| - | - |\n| longer cell | x |\n";
const ALIGNED_TABLE =
  "| a           | b   |\n| ----------- | --- |\n| longer cell | x   |\n";
const PREFER_CONST_CONFIG =
  "export default [{ rules: { 'prefer-const': 'error' } }];\n";

let repo;

function git(...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function explain() {
  return spawnSync(process.execPath, [SCRIPT], { cwd: repo, encoding: "utf8" });
}

function stageThenEditAfter(file, stagedContent) {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), stagedContent);
  git("add", file);
  writeFileSync(join(repo, file), `${stagedContent}\nline outside the stage\n`);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "bcct-explain-lint-staged-"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
  copyFileSync(join(ROOT, "package.json"), join(repo, "package.json"));
  copyFileSync(
    join(ROOT, "lint-staged.config.mjs"),
    join(repo, "lint-staged.config.mjs"),
  );
  writeFileSync(join(repo, "eslint.config.mjs"), PREFER_CONST_CONFIG);
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  git(
    "add",
    ".gitignore",
    "package.json",
    "lint-staged.config.mjs",
    "eslint.config.mjs",
  );
  git("commit", "-qm", "base");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("explain-lint-staged-failure", { timeout: TOOL_TIMEOUT }, () => {
  it("points out the staged file that prettier would change and that has changes outside the stage", () => {
    stageThenEditAfter("docs/notes.md", UNALIGNED_TABLE);

    const result = explain();

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/docs\/notes\.md \(prettier\)/);
    expect(result.stdout).toMatch(/git show :docs\/notes\.md/);
  });

  it("accepts a string task in the lint-staged config", () => {
    writeFileSync(
      join(repo, "lint-staged.config.mjs"),
      'export default { "*.md": "prettier --write" };\n',
    );
    stageThenEditAfter("notes.md", UNALIGNED_TABLE);

    const result = explain();

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/notes\.md \(prettier\)/);
  });

  it("points out the staged file that eslint --fix would change", () => {
    stageThenEditAfter("src/a.js", "let value = 1;\nconsole.log(value);\n");

    const result = explain();

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/src\/a\.js \(eslint --fix\)/);
  });

  it("does not point out a file that already passes prettier and eslint --fix", () => {
    stageThenEditAfter("src/a.js", "const value = 1;\nconsole.log(value);\n");

    const result = explain();

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("does not point out eslint when it breaks without a report, because the lint-staged error is eslint's own", () => {
    writeFileSync(join(repo, "eslint.config.mjs"), "export default [{\n");
    stageThenEditAfter("src/a.js", "const value = 1;\nconsole.log(value);\n");

    const result = explain();

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("does not point out a file outside the lint-staged globs, which it does not process", () => {
    stageThenEditAfter("LICENSE", "line   with   spaces\n");

    const result = explain();

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("points out a dotfile, which lint-staged also processes", () => {
    stageThenEditAfter(".oxlintrc.json", '{"rules":{}}\n');

    const result = explain();

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\.oxlintrc\.json \(prettier\)/);
  });

  it("does not point out a file prettier cannot parse, because the lint-staged error is prettier's own", () => {
    stageThenEditAfter("broken.json", '{"rules":\n');

    const result = explain();

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("does not point out a partially staged file that is already formatted", () => {
    stageThenEditAfter("notes.md", ALIGNED_TABLE);

    const result = explain();

    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/notes\.md/);
  });

  it("does not point out an unformatted file staged whole, because lint-staged fixes it without conflict", () => {
    writeFileSync(join(repo, "notes.md"), UNALIGNED_TABLE);
    git("add", "notes.md");

    const result = explain();

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });
});
