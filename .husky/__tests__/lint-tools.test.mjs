import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { miseEnv } from "./support/mise-env.mjs";
import {
  MISSPELLED,
  PORTUGUESE_SENTENCE,
  TYPOS_REPORT,
} from "./support/typo-fixtures.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const MISE_EXEC = join(ROOT, "scripts", "mise-exec.sh");
const TOOL_TIMEOUT = 60_000;

const BAD_WORKFLOW = [
  "name: bad",
  "on: issues",
  "jobs:",
  "  echo:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  '      - run: echo "${{ github.event.issue.title }}"',
].join("\n");
const GOOD_WORKFLOW = [
  "name: good",
  "on: push",
  "permissions: {}",
  "jobs:",
  "  echo:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955 # v4.3.0",
  "        with:",
  "          persist-credentials: false",
  '      - run: echo "$TITLE"',
  "        env:",
  "          TITLE: ${{ github.event.head_commit.message }}",
].join("\n");

const TOOL_CONFIG = ["mise.toml", "mise.lock", "_typos.toml"];

let dir;

function tool(...args) {
  return spawnSync("sh", [MISE_EXEC, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...miseEnv(dir) },
  });
}

function fixture(name, content) {
  mkdirSync(join(dir, name, ".."), { recursive: true });
  writeFileSync(join(dir, name), `${content}\n`);

  return name;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bcct-lint-tools-"));

  for (const file of TOOL_CONFIG) {
    copyFileSync(join(ROOT, file), join(dir, file));
  }

  cpSync(join(ROOT, ".mise"), join(dir, ".mise"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, ".git", "notes.md"), `${MISSPELLED}\n`);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("pinned lint tools", { timeout: TOOL_TIMEOUT }, () => {
  it("runs the versions of mise.toml", () => {
    expect(tool("typos", "--version").stdout).toContain("1.51.1");
    expect(tool("actionlint", "--version").stdout).toContain("1.7.12");
    expect(tool("pinact", "--version").stdout).toContain("5.0.0");
    expect(tool("zizmor", "--version").stdout).toContain("1.31.1");
  });

  describe("typos with _typos.toml", () => {
    it("catches an English typo", () => {
      const file = fixture("notes.md", `the ${MISSPELLED} function`);

      const result = tool("typos", "--force-exclude", file);

      expect(result.status).toBe(2);
      expect(result.stdout).toContain(TYPOS_REPORT);
    });

    it("walks hidden folders like .husky and .github when it checks the whole repository, as lint:typos does", () => {
      fixture(".husky/__tests__/hidden.test.mjs", `// ${MISSPELLED}`);

      const result = tool("typos", "--format", "brief");

      expect(result.status).toBe(2);
      expect(result.stdout).toContain(".husky/__tests__/hidden.test.mjs");
      expect(result.stdout).not.toContain(".git/");
    });

    it("accepts the Portuguese words the code uses in its pt-br messages", () => {
      const file = fixture(
        "i18n.ts",
        "export const pt = 'Instale o comando; foto e texto transcrito, sem erro. Aprove.';",
      );

      expect(tool("typos", "--force-exclude", file).status).toBe(0);
    });

    it("skips the pt-br docs passed by the path relative to the repository, as lint-staged passes them", () => {
      const result = tool(
        "typos",
        "--force-exclude",
        fixture("README.pt-br.md", PORTUGUESE_SENTENCE),
        fixture(
          "docs/decisions/Fork/000-fork-decisoes.md",
          PORTUGUESE_SENTENCE,
        ),
      );

      expect(result.stdout).toBe("");
      expect(result.status).toBe(0);
    });
  });

  describe("workflow linters", () => {
    it("actionlint, zizmor offline and pinact offline reject an injectable, unpinned workflow", () => {
      const file = fixture(".github/workflows/bad.yml", BAD_WORKFLOW);
      const zizmor = tool("zizmor", "--offline", file);

      expect(tool("actionlint", file).status).not.toBe(0);
      expect(zizmor.status).not.toBe(0);
      expect(zizmor.stdout).toContain("template-injection");
      expect(zizmor.stdout).toContain("unpinned-uses");
      expect(
        tool("pinact", "run", "--fix=false", "--no-api", file).status,
      ).not.toBe(0);
    });

    it("the three accept a pinned workflow with no permissions and inputs passed by env", () => {
      const file = fixture(".github/workflows/good.yml", GOOD_WORKFLOW);

      expect(tool("actionlint", file).status).toBe(0);
      expect(tool("zizmor", "--offline", file).status).toBe(0);
      expect(
        tool("pinact", "run", "--fix=false", "--no-api", file).status,
      ).toBe(0);
    });
  });
});
