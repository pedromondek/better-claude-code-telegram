#!/usr/bin/env node
import {
  checkLockfileSync,
  formatReport,
} from "../../scripts/check-lockfile-sync.mjs";

const DEPENDENCY_COMMANDS = new Set([
  "install",
  "i",
  "in",
  "ins",
  "inst",
  "insta",
  "instal",
  "isnt",
  "isnta",
  "isntal",
  "isntall",
  "add",
  "uninstall",
  "unlink",
  "un",
  "remove",
  "rm",
  "r",
  "update",
  "up",
  "upgrade",
  "udpate",
  "dedupe",
  "ddp",
  "prune",
  "install-test",
  "it",
]);

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

function changesDependencies(command) {
  return command.split(/&&|\|\||[;|\n]/).some((segment) => {
    const tokens = segment.trim().split(/\s+/);
    const npmAt = tokens.findIndex(
      (token) => token === "npm" || token.endsWith("/npm"),
    );

    if (npmAt === -1) return false;

    return tokens
      .slice(npmAt + 1)
      .some((token) => DEPENDENCY_COMMANDS.has(token));
  });
}

const input = await readHookInput();
const command = input.tool_input?.command;

if (typeof command === "string" && changesDependencies(command)) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd;

  if (projectDir) {
    const report = formatReport(
      [await checkLockfileSync(projectDir)],
      projectDir,
    );

    if (report !== "") {
      process.stdout.write(
        JSON.stringify({
          decision: "block",
          reason: `The install left the lock out of sync. Fix it before moving on:\n${report}`,
        }),
      );
    }
  }
}
