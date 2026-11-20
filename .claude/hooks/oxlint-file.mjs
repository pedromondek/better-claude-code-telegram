#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { projectRelativePath, readHookInput } from "./lib/hook-input.mjs";

const LINTABLE = /\.(?:m|c)?[jt]sx?$/;

const input = await readHookInput();
const file =
  input?.tool_response?.filePath ?? input?.tool_input?.file_path ?? "";
const projectDir = process.env.CLAUDE_PROJECT_DIR || input?.cwd;

if (
  file &&
  projectDir &&
  projectRelativePath(file, projectDir) !== undefined &&
  LINTABLE.test(file) &&
  existsSync(file)
) {
  const binary = join(projectDir, "node_modules", ".bin", "oxlint");

  if (existsSync(binary) && existsSync(join(projectDir, ".oxlintrc.json"))) {
    const result = spawnSync(
      binary,
      ["--format", "unix", "--max-warnings", "0", file],
      { cwd: projectDir, encoding: "utf8" },
    );
    const problems = (result.stdout ?? "").trim();

    if (result.status !== 0 && problems) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: `oxlint flagged the file you just edited. Fix it before moving on:\n${problems}`,
          },
        }),
      );
    }
  }
}
