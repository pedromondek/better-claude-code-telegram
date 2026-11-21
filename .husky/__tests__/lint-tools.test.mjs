import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
const TOKEN_ENV = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "ZIZMOR_GITHUB_TOKEN",
  "PINACT_GITHUB_TOKEN",
]);
const REPO_FILES = [
  "mise.toml",
  "mise.lock",
  "scripts/mise-exec.sh",
  "scripts/lint-workflows.mjs",
  ".github/actionlint.yaml",
  ".github/jactionlint.yaml",
];

const CALLED = ".github/workflows/called.yml";
const CALLER = ".github/workflows/caller.yml";

const CALLED_WORKFLOW = [
  "name: called",
  "on:",
  "  workflow_call:",
  "    inputs:",
  "      before:",
  "        required: true",
  "        type: string",
  "permissions: {}",
  "defaults:",
  "  run:",
  "    shell: bash",
  "jobs:",
  "  run:",
  "    name: Run",
  "    runs-on: ubuntu-24.04",
  "    permissions:",
  "      contents: read",
  "    steps:",
  "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  "        with:",
  "          persist-credentials: false",
  "      - run: node scripts/x.mjs | tee out.log",
  "        env:",
  "          BEFORE: ${{ inputs.before }}",
].join("\n");
const CALLER_WORKFLOW = [
  "name: caller",
  "on: push",
  "permissions: {}",
  "concurrency:",
  "  group: ${{ github.workflow }}-${{ github.ref }}",
  "  cancel-in-progress: true",
  "defaults:",
  "  run:",
  "    shell: bash",
  "jobs:",
  "  call:",
  "    name: Call",
  "    permissions:",
  "      contents: read",
  "    uses: $/.github/workflows/called.yml",
  "    with:",
  "      before: ${{ github.event.before }}",
].join("\n");

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
    expect(tool("pinact", "--version").stdout).toContain("5.0.2");
    expect(tool("zizmor", "--version").stdout).toContain("1.31.1");
    expect(tool("jactionlint", "--version").stdout).toContain("2.3.0");
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

    it("skips the pt-br docs and issue forms passed by the path relative to the repository, as lint-staged passes them", () => {
      const result = tool(
        "typos",
        "--force-exclude",
        fixture("README.pt-br.md", PORTUGUESE_SENTENCE),
        fixture(".github/ISSUE_TEMPLATE/1-bug.pt-br.yml", PORTUGUESE_SENTENCE),
        fixture(
          "docs/decisions/Fork/000-fork-decisoes.md",
          PORTUGUESE_SENTENCE,
        ),
        fixture("docs/releases/0.1.0/alpha.1.md", PORTUGUESE_SENTENCE),
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

describe("workflow lint scripts", { timeout: TOOL_TIMEOUT }, () => {
  let repo;

  function write(name, content) {
    mkdirSync(join(repo, name, ".."), { recursive: true });
    writeFileSync(join(repo, name), `${content}\n`);
  }

  function script(name) {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !TOKEN_ENV.has(key)),
    );

    return spawnSync("npm", ["run", "--silent", name], {
      cwd: repo,
      encoding: "utf8",
      env: { ...env, ...miseEnv(repo) },
    });
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "bcct-lint-workflows-repo-"));

    for (const file of REPO_FILES) {
      mkdirSync(join(repo, file, ".."), { recursive: true });
      copyFileSync(join(ROOT, file), join(repo, file));
    }

    const { scripts } = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    );
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        name: "fixture",
        scripts: Object.fromEntries(
          Object.entries(scripts).filter(([name]) =>
            name.startsWith("lint:workflows"),
          ),
        ),
      }),
    );

    execFileSync("git", ["init", "-q"], { cwd: repo });
  });

  beforeEach(() => {
    write(CALLED, CALLED_WORKFLOW);
    write(CALLER, CALLER_WORKFLOW);
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("workflows in the pattern of the repository pass the whole lint:workflows", () => {
    const result = script("lint:workflows");

    expect(result.stdout + result.stderr).not.toContain("✗");
    expect(result.status).toBe(0);
  });

  it("jactionlint follows the call through $/ and rejects a required input the job does not pass", () => {
    write(CALLER, CALLER_WORKFLOW.replace(/\n {4}with:\n.*$/u, ""));

    const result = script("lint:workflows:jactionlint");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("[missing-workflow-input]");
  });

  it("jactionlint rejects a pipeline whose failure vanishes without the bash shell of defaults", () => {
    write(
      CALLED,
      CALLED_WORKFLOW.replace("defaults:\n  run:\n    shell: bash\n", ""),
    );

    const result = script("lint:workflows:jactionlint");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("[pipeline-without-pipefail]");
  });

  it("zizmor runs with every audit of the auditor persona, which the regular persona hides", () => {
    write(
      CALLED,
      CALLED_WORKFLOW.replace(
        "      contents: read\n",
        "      contents: read\n      issues: write\n",
      ),
    );

    const result = script("lint:workflows:zizmor");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("undocumented-permissions");
  });
});
