import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

export function gitVariablesIn(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((name) => name.startsWith("GIT_"));
}

export function isolateHome(base: string): {
  home: string;
  remove: () => void;
} {
  const home = mkdtempSync(join(base, "bcct-home-"));

  return {
    home,
    remove: (): void => {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export const PRE_PUSH_CONTROL_VARIABLES = [
  "PREPUSH_SKIP_MUTATION",
  "PREPUSH_SKIP_BRANCH_CHECK",
  "PREPUSH_SKIP_PR_UNLOCK",
  "MUTATION_RANGE",
  "MUTATION_BEFORE",
  "MUTATION_FORCE",
  "COVERAGE_RANGE",
  "TEST_PROGRESS_FILE",
];

for (const name of [
  ...gitVariablesIn(process.env),
  ...PRE_PUSH_CONTROL_VARIABLES,
]) {
  delete process.env[name];
}

const isolated = isolateHome(tmpdir());

process.env.HOME = isolated.home;
process.env.USERPROFILE = isolated.home;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.TELEGRAM_STATE_DIR;
delete process.env.BETTER_CC_TELEGRAM;

afterAll(isolated.remove);
