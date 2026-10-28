#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";

async function readHookInput() {
  const chunks = [];

  try {
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }

    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function insideProject(file, projectDir) {
  const path = relative(resolve(projectDir), resolve(projectDir, file));

  return (
    path !== "" &&
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
}

const input = await readHookInput();
const file =
  input?.tool_response?.filePath ?? input?.tool_input?.file_path ?? "";
const projectDir = process.env.CLAUDE_PROJECT_DIR || input?.cwd;

if (file && projectDir && insideProject(file, projectDir)) {
  spawnSync(
    "npm",
    ["run", "--silent", "format:file", "--", "--ignore-unknown", file],
    { cwd: projectDir, stdio: "ignore" },
  );
}
