import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function gitVariablesIn(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((name) => name.startsWith("GIT_"));
}

for (const name of gitVariablesIn(process.env)) {
  delete process.env[name];
}

const isolatedHome = mkdtempSync(join(tmpdir(), "bcct-home-"));

process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.TELEGRAM_STATE_DIR;
