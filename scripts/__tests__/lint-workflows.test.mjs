import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { touchesWorkflowLint } from "../lint-workflows.mjs";

const SCRIPT = join(import.meta.dirname, "..", "lint-workflows.mjs");
const TOOLS = ["actionlint", "jactionlint", "zizmor", "pinact"];

let dir;

function writeScripts(scripts) {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture", scripts }),
  );
}

function passing(overrides = {}) {
  return Object.fromEntries(
    TOOLS.map((tool) => [
      `lint:workflows:${tool}`,
      overrides[tool] ?? `echo ${tool.toUpperCase()}_RAN`,
    ]),
  );
}

function run() {
  return spawnSync("node", [SCRIPT], { cwd: dir, encoding: "utf8" });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bcct-lint-workflows-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("lint-workflows as a module", () => {
  it("imported without an entry script (node -e) neither runs nor breaks", () => {
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(SCRIPT)}); console.log(typeof m.runScript);`,
      ],
      { cwd: dir, encoding: "utf8" },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("function");
  });
});

describe("lint-workflows", () => {
  it("runs the four tools through their package.json scripts and exits 0 when all pass", () => {
    writeScripts(passing());

    const result = run();

    expect(result.status).toBe(0);
    for (const tool of TOOLS) {
      expect(result.stdout).toContain(`✓ lint:workflows:${tool}`);
    }
  });

  it("collects the failures: runs them all, shows the output of each one that failed and exits 1", () => {
    writeScripts(
      passing({
        actionlint: "echo ACTIONLINT_FINDING && exit 1",
        zizmor: "echo ZIZMOR_FINDING >&2 && exit 14",
        pinact: "echo PINACT_RAN > pinact.ran",
      }),
    );

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(
      /✗ lint:workflows:actionlint\n[^]*ACTIONLINT_FINDING/u,
    );
    expect(result.stdout).toMatch(
      /✗ lint:workflows:zizmor\n[^]*ZIZMOR_FINDING/u,
    );
    expect(result.stdout).toContain("✓ lint:workflows:jactionlint");
    expect(result.stdout).toContain("✓ lint:workflows:pinact");
    expect(readFileSync(join(dir, "pinact.ran"), "utf8")).toBe("PINACT_RAN\n");
  });

  it("hides the output of a tool that passed", () => {
    writeScripts(passing({ jactionlint: "echo NOISE_FROM_PASSING_TOOL" }));

    expect(run().stdout).not.toContain("NOISE_FROM_PASSING_TOOL");
  });

  it("fails a script missing from package.json by its name, without hiding it, and still runs the other tools", () => {
    const scripts = passing({ pinact: "echo PINACT_RAN > pinact.ran" });
    delete scripts["lint:workflows:zizmor"];
    writeScripts(scripts);

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "✗ lint:workflows:zizmor is not in package.json",
    );
    expect(result.stdout).toContain("✓ lint:workflows:pinact");
  });

  it("does not print the npm run header", () => {
    writeScripts(passing({ actionlint: "exit 1" }));

    expect(run().stdout).not.toMatch(/^> /mu);
  });
});

describe("touchesWorkflowLint", () => {
  it.each([
    ".github/workflows/ci.yml",
    ".github/workflows/release.yaml",
    ".github/actions/setup/action.yml",
    ".github/actions/group/setup/action.yaml",
    ".github/actionlint.yaml",
    ".github/actionlint.yml",
    ".github/jactionlint.yaml",
    ".github/jactionlint.yml",
    ".github/dependabot.yml",
    ".github/zizmor.yml",
    ".github/pinact.yaml",
    ".github/pinact.yml",
    "mise.toml",
    "mise.lock",
    ".github\\workflows\\ci.yml",
  ])("matches %s", (file) => {
    expect(touchesWorkflowLint(file)).toBe(true);
  });

  it.each([
    "scripts/release.mjs",
    ".github/workflows/nested/ci.yml",
    ".github/workflows/ci.txt",
    ".github/actions/setup/README.md",
    ".github/CODEOWNERS",
    "docs/mise.toml",
    "mise.toml.bak",
    "package.json",
  ])("does not match %s", (file) => {
    expect(touchesWorkflowLint(file)).toBe(false);
  });
});
