#!/usr/bin/env node
import { spawnSync } from "node:child_process";

import { projectRelativePath, readHookInput } from "./lib/hook-input.mjs";

const input = await readHookInput();
const file =
  input?.tool_response?.filePath ?? input?.tool_input?.file_path ?? "";
const projectDir = process.env.CLAUDE_PROJECT_DIR || input?.cwd;

if (file && projectDir && projectRelativePath(file, projectDir) !== undefined) {
  spawnSync(
    "npm",
    ["run", "--silent", "format:file", "--", "--ignore-unknown", file],
    { cwd: projectDir, stdio: "ignore" },
  );
}
