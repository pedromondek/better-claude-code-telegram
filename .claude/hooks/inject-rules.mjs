#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { projectRelativePath, readHookInput } from "./lib/hook-input.mjs";

const CODE_FILE = /\.(?:ts|mjs|js|cjs|sh)$/;
const TEST_FILE = /(?:^|\/)__tests__\/(?:.*\/)?[^/]*\.test\.[^/]+$/;
const DOCS_FILE = /^docs\/.*\.md$/;
const GIT_FOLDER = /^(?:\.husky|scripts|\.github)\//;

const PREAMBLE =
  "New file: path-scoped rules load when a file is edited, not when it is created. Follow these conventions when writing it:";

function rulesFor(path) {
  const rules = [];

  if (CODE_FILE.test(path)) rules.push("general");
  if (CODE_FILE.test(path) && TEST_FILE.test(path)) {
    rules.push("testing", "stryker");
  }
  if (DOCS_FILE.test(path)) rules.push("docs");
  if (GIT_FOLDER.test(path)) rules.push("git");

  return rules;
}

const input = await readHookInput();
const file = input?.tool_input?.file_path;
const projectDir = process.env.CLAUDE_PROJECT_DIR || input?.cwd;

if (typeof file === "string" && file !== "" && projectDir) {
  const path = projectRelativePath(file, projectDir);
  const contents = (path === undefined ? [] : rulesFor(path))
    .map((name) => join(projectDir, ".claude", "rules", `${name}.md`))
    .filter((ruleFile) => existsSync(ruleFile))
    .map((ruleFile) => readFileSync(ruleFile, "utf8").trim());

  if (contents.length > 0) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: [PREAMBLE, ...contents].join("\n\n"),
        },
      }),
    );
  }
}
