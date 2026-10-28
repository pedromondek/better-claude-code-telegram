import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HOOK = join(import.meta.dirname, "..", "oxlint-file.mjs");

let root;
let project;

function makeOxlintRoot(dir, { exitCode = 1 } = {}) {
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(dir, ".oxlintrc.json"), "{}");
  writeFileSync(
    join(dir, "node_modules", ".bin", "oxlint"),
    `#!/bin/sh\nfor last; do :; done\necho "$last:1:1: fake problem"\nexit ${exitCode}\n`,
  );
  chmodSync(join(dir, "node_modules", ".bin", "oxlint"), 0o755);
}

function writeSource(dir, name = "app.ts") {
  const file = join(dir, "src", name);

  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(file, "export const value = 1;\n");

  return file;
}

function runHook(input) {
  return spawnSync(process.execPath, [HOOK], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: project },
  });
}

function runFor(file) {
  return runHook({ tool_input: { file_path: file } });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bcct-oxlint-file-"));
  project = join(root, "project");
  mkdirSync(project, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("oxlint-file", () => {
  it("returns the oxlint findings as additionalContext for a file inside CLAUDE_PROJECT_DIR", () => {
    makeOxlintRoot(project);
    const file = writeSource(project);

    const output = JSON.parse(runFor(file).stdout);

    expect(output.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(output.hookSpecificOutput.additionalContext).toMatch(
      /oxlint flagged the file you just edited/u,
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      `${file}:1:1: fake problem`,
    );
  });

  it("lints the file with the oxlint binary of the project root and the unix format", () => {
    makeOxlintRoot(project);
    writeFileSync(
      join(project, "node_modules", ".bin", "oxlint"),
      '#!/bin/sh\necho "$PWD|$*"\nexit 1\n',
    );
    const file = writeSource(project);

    const output = JSON.parse(runFor(file).stdout);

    expect(output.hookSpecificOutput.additionalContext).toContain(
      `${project}|--format unix --max-warnings 0 ${file}`,
    );
  });

  it("stays silent when oxlint finds nothing", () => {
    makeOxlintRoot(project, { exitCode: 0 });
    const file = writeSource(project);

    const result = runFor(file);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("stays silent when oxlint fails without printing a finding", () => {
    makeOxlintRoot(project);
    writeFileSync(
      join(project, "node_modules", ".bin", "oxlint"),
      "#!/bin/sh\nexit 1\n",
    );
    const file = writeSource(project);

    expect(runFor(file).stdout).toBe("");
  });

  it("lints every JavaScript and TypeScript extension", () => {
    makeOxlintRoot(project);

    for (const name of ["a.ts", "a.tsx", "a.js", "a.mjs", "a.cjs", "a.mts"]) {
      expect(runFor(writeSource(project, name)).stdout).not.toBe("");
    }
  });

  it("does not lint a file that is not JavaScript or TypeScript", () => {
    makeOxlintRoot(project);

    for (const name of ["a.md", "a.json", "a.sh"]) {
      expect(runFor(writeSource(project, name)).stdout).toBe("");
    }
  });

  it("does not lint a file that does not exist", () => {
    makeOxlintRoot(project);

    expect(runFor(join(project, "src", "missing.ts")).stdout).toBe("");
  });

  it("stays silent when the project has no oxlint binary or no .oxlintrc.json", () => {
    const file = writeSource(project);

    expect(runFor(file).stdout).toBe("");

    makeOxlintRoot(project);
    rmSync(join(project, ".oxlintrc.json"));

    expect(runFor(file).stdout).toBe("");
  });

  it("does not look for an oxlint setup in a subfolder of the project", () => {
    makeOxlintRoot(join(project, "nested"));
    const file = writeSource(join(project, "nested"));

    expect(runFor(file).stdout).toBe("");
  });

  it("prefers the filePath of the tool_response over the file_path of the tool_input", () => {
    makeOxlintRoot(project);
    const written = writeSource(project, "written.ts");

    const output = JSON.parse(
      runHook({
        tool_response: { filePath: written },
        tool_input: { file_path: join(project, "src", "requested.ts") },
      }).stdout,
    );

    expect(output.hookSpecificOutput.additionalContext).toContain(written);
  });

  it("does not run oxlint on a file of another repository outside CLAUDE_PROJECT_DIR", () => {
    const other = join(root, "other-repo");

    makeOxlintRoot(other);
    const file = writeSource(other);

    const result = runFor(file);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("does not run oxlint on a sibling folder that only starts with the project name", () => {
    const sibling = `${project}-copy`;

    makeOxlintRoot(sibling);
    const file = writeSource(sibling);

    expect(runFor(file).stdout).toBe("");
  });

  it("exits 0 with no output when stdin is not JSON or carries no file", () => {
    for (const input of ["not json", { tool_input: {} }]) {
      const result = runHook(input);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    }
  });
});
