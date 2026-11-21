import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const WORKFLOWS_ROOT = ".claude/workflows";
export const WORKFLOW_TESTS_DIR = `${WORKFLOWS_ROOT}/__tests__`;

export function vitestArguments() {
  return ["run", "--root", WORKFLOWS_ROOT];
}

export function testWorkflows({ exists, run, log }) {
  if (!exists(WORKFLOW_TESTS_DIR)) {
    log(
      `⚠ ${WORKFLOW_TESTS_DIR} does not exist in this clone: workflow tests skipped`,
    );
    return 0;
  }

  const result = run(vitestArguments());

  if (result.error) {
    log(`✗ vitest did not start: ${result.error.message}`);
    return 1;
  }

  return result.status === 0 ? 0 : 1;
}

function main() {
  const vitest = join(
    import.meta.dirname,
    "..",
    "node_modules",
    "vitest",
    "vitest.mjs",
  );

  process.exitCode = testWorkflows({
    exists: existsSync,
    run: (args) =>
      spawnSync(process.execPath, [vitest, ...args], { stdio: "inherit" }),
    log: (line) => console.log(line),
  });
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main();
}
