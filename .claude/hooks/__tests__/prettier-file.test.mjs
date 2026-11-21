import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HOOK = join(import.meta.dirname, "..", "prettier-file.mjs");

let root;
let project;
let npmLog;
let binDir;

function runHook(input) {
  return spawnSync(process.execPath, [HOOK], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      CLAUDE_PROJECT_DIR: project,
      FAKE_NPM_LOG: npmLog,
    },
  });
}

function npmCalls() {
  return existsSync(npmLog)
    ? readFileSync(npmLog, "utf8").split("\n").filter(Boolean)
    : [];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bcct-prettier-file-"));
  project = join(root, "project");
  binDir = join(root, "bin");
  npmLog = join(root, "npm.log");
  mkdirSync(project, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "npm"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_NPM_LOG"\n',
  );
  chmodSync(join(binDir, "npm"), 0o755);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("prettier-file", () => {
  it("formats a file written inside CLAUDE_PROJECT_DIR through the format:file script", () => {
    const file = join(project, "src", "app.ts");

    runHook({ tool_input: { file_path: file } });

    expect(npmCalls()).toEqual([
      `run --silent format:file -- --ignore-unknown ${file}`,
    ]);
  });

  it("prefers the filePath of the tool_response over the file_path of the tool_input", () => {
    const written = join(project, "written.ts");

    runHook({
      tool_response: { filePath: written },
      tool_input: { file_path: join(project, "requested.ts") },
    });

    expect(npmCalls()).toEqual([
      `run --silent format:file -- --ignore-unknown ${written}`,
    ]);
  });

  it("falls back to the cwd of the input when CLAUDE_PROJECT_DIR is not set", () => {
    const file = join(project, "app.ts");
    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

    delete env.CLAUDE_PROJECT_DIR;
    env.FAKE_NPM_LOG = npmLog;
    spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ cwd: project, tool_input: { file_path: file } }),
      encoding: "utf8",
      env,
    });

    expect(npmCalls()).toEqual([
      `run --silent format:file -- --ignore-unknown ${file}`,
    ]);
  });

  it("does not format a file outside CLAUDE_PROJECT_DIR", () => {
    runHook({ tool_input: { file_path: join(root, "other", "server.ts") } });

    expect(npmCalls()).toEqual([]);
  });

  it("does not format a sibling folder that only starts with the project name", () => {
    runHook({ tool_input: { file_path: `${project}-copy/server.ts` } });

    expect(npmCalls()).toEqual([]);
  });

  it("does not format the project directory itself", () => {
    runHook({ tool_input: { file_path: project } });

    expect(npmCalls()).toEqual([]);
  });

  it("does nothing when the input carries no file path", () => {
    runHook({ tool_input: {} });

    expect(npmCalls()).toEqual([]);
  });

  it("exits 0 with no output when stdin is not JSON", () => {
    const result = runHook("not json");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(npmCalls()).toEqual([]);
  });
});
