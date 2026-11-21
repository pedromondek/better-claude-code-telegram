import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const EXTRA_HOOKS = ["reference-transaction"];

const HUSKY_TEMPLATE_HOOK = "pre-commit";

export function installExtraHooks(huskyDir) {
  const installed = join(huskyDir, "_");
  const template = join(installed, HUSKY_TEMPLATE_HOOK);

  if (!existsSync(template)) return [];

  const wrapper = readFileSync(template, "utf8");

  for (const hook of EXTRA_HOOKS) {
    const target = join(installed, hook);
    writeFileSync(target, wrapper);
    chmodSync(target, 0o755);
  }

  return EXTRA_HOOKS;
}

if (import.meta.main) {
  installExtraHooks(join(import.meta.dirname, "..", ".husky"));
}
