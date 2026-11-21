import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HOOK = join(import.meta.dirname, "..", "inject-rules.mjs");
const RULES = ["general", "testing", "stryker", "docs", "git"];

let root;
let project;

function writeRules(names = RULES) {
  mkdirSync(join(project, ".claude", "rules"), { recursive: true });

  for (const name of names) {
    writeFileSync(
      join(project, ".claude", "rules", `${name}.md`),
      `# rule ${name}\n`,
    );
  }
}

function run(input, env = {}) {
  return spawnSync(process.execPath, [HOOK], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, ...env },
  });
}

function runFor(file) {
  return run({ tool_name: "Write", tool_input: { file_path: file } });
}

function injectedFor(relativePath) {
  const result = runFor(join(project, relativePath));

  expect(result.status).toBe(0);

  if (result.stdout === "") return [];

  const output = JSON.parse(result.stdout).hookSpecificOutput;

  expect(output.hookEventName).toBe("PreToolUse");

  return [...output.additionalContext.matchAll(/^# rule (\w+)$/gmu)].map(
    (match) => match[1],
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bcct-inject-rules-"));
  project = join(root, "project");
  mkdirSync(project, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("inject-rules: which rules each new file gets", () => {
  it("injects the general rule for every code extension", () => {
    writeRules();

    for (const file of [
      "plugins/telegram/extensions/new.ts",
      "plugins/telegram/extensions/nested/new.ts",
      "src/new.mjs",
      "src/new.js",
      "src/new.cjs",
      "src/new.sh",
    ]) {
      expect(injectedFor(file)).toEqual(["general"]);
    }
  });

  it("injects the testing and mutation rules after the general one for a test file", () => {
    writeRules();

    for (const file of [
      "scripts/__tests__/new.test.mjs",
      ".claude/hooks/__tests__/new.test.mjs",
      "plugins/telegram/extensions/__tests__/new.test.ts",
      "plugins/telegram/extensions/__tests__/deep/new.test.ts",
      "scripts/__tests__/new.e2e.test.mjs",
    ]) {
      const rules = injectedFor(file);

      expect(rules.slice(0, 3)).toEqual(["general", "testing", "stryker"]);
    }
  });

  it("does not treat a file inside __tests__ without .test. in its name as a test", () => {
    writeRules();

    expect(injectedFor("plugins/__tests__/support/helper.mjs")).toEqual([
      "general",
    ]);
    expect(injectedFor("plugins/new.test.mjs")).toEqual(["general"]);
  });

  it("injects the docs rule, and only it, for a markdown file under docs", () => {
    writeRules();

    expect(injectedFor("docs/guide.md")).toEqual(["docs"]);
    expect(injectedFor("docs/nested/deep/guide.md")).toEqual(["docs"]);
  });

  it("does not inject for a markdown file outside docs or a non-markdown file under docs", () => {
    writeRules();

    expect(injectedFor("README.md")).toEqual([]);
    expect(injectedFor("docs/diagram.png")).toEqual([]);
    expect(injectedFor("notes/guide.md")).toEqual([]);
  });

  it("adds the git rule under .husky, scripts and .github", () => {
    writeRules();

    expect(injectedFor("scripts/new.mjs")).toEqual(["general", "git"]);
    expect(injectedFor("scripts/__tests__/new.test.mjs")).toEqual([
      "general",
      "testing",
      "stryker",
      "git",
    ]);
    expect(injectedFor(".husky/lib/new.sh")).toEqual(["general", "git"]);
    expect(injectedFor(".husky/pre-new")).toEqual(["git"]);
    expect(injectedFor(".github/workflows/new.yml")).toEqual(["git"]);
    expect(injectedFor(".github/scripts/new.mjs")).toEqual(["general", "git"]);
  });

  it("does not add the git rule for a folder that only starts like a git folder", () => {
    writeRules();

    expect(injectedFor("scripts-extra/new.mjs")).toEqual(["general"]);
    expect(injectedFor("src/scripts/new.mjs")).toEqual(["general"]);
  });

  it("injects nothing for files that are not code, docs or git infrastructure", () => {
    writeRules();

    for (const file of [
      "package.json",
      "tsconfig.json",
      "mise.toml",
      "src/new.py",
      ".claude/settings.json",
    ]) {
      expect(injectedFor(file)).toEqual([]);
    }
  });

  it("starts the context with a preamble in English and joins the rules with a blank line", () => {
    writeRules();

    const output = JSON.parse(
      runFor(join(project, "scripts", "new.mjs")).stdout,
    );
    const context = output.hookSpecificOutput.additionalContext;

    expect(context).toMatch(/^New file: /u);
    expect(context).toContain("# rule general\n\n# rule git");
  });
});

describe("inject-rules: rules that do not exist", () => {
  it("injects only the rule files that exist", () => {
    writeRules(["testing", "git"]);

    expect(injectedFor("scripts/__tests__/new.test.mjs")).toEqual([
      "testing",
      "git",
    ]);
  });

  it("exits 0 with no output when no rule file exists", () => {
    const result = runFor(
      join(project, "scripts", "__tests__", "new.test.mjs"),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 with no output when the rules folder is empty", () => {
    mkdirSync(join(project, ".claude", "rules"), { recursive: true });

    expect(injectedFor("src/new.mjs")).toEqual([]);
  });
});

describe("inject-rules: input it must not act on", () => {
  it("ignores a file outside the project", () => {
    writeRules();

    expect(runFor(join(root, "other", "new.mjs")).stdout).toBe("");
    expect(runFor(`${project}-copy/new.mjs`).stdout).toBe("");
  });

  it("ignores the project directory itself and a missing file path", () => {
    writeRules();

    expect(runFor(project).stdout).toBe("");
    expect(run({ tool_name: "Write", tool_input: {} }).stdout).toBe("");
  });

  it("resolves a relative path against the project", () => {
    writeRules();

    const result = runFor("src/new.mjs");

    expect(
      JSON.parse(result.stdout).hookSpecificOutput.additionalContext,
    ).toContain("# rule general");
  });

  it("falls back to the cwd of the input when CLAUDE_PROJECT_DIR is not set", () => {
    writeRules();
    const env = { ...process.env };

    delete env.CLAUDE_PROJECT_DIR;
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        cwd: project,
        tool_input: { file_path: join(project, "src", "new.mjs") },
      }),
      encoding: "utf8",
      env,
    });

    expect(result.stdout).toContain("# rule general");
  });

  it("exits 0 with no output when stdin is not JSON", () => {
    writeRules();

    const result = run("not json");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });
});
