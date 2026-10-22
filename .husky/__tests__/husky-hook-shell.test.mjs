import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { HUSKY_HOOK_ARGS } from "./support/husky-hook.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const SH_SPAWN = /spawn(?:Sync)?\(\s*"sh",\s*\[\s*([^,\]]+)/g;
const PLAIN_SH_TARGETS = new Set(['"-c"', "MISE_EXEC"]);

const testSources = globSync(".husky/__tests__/*.test.mjs", { cwd: ROOT }).map(
  (file) => ({ file, source: readFileSync(join(ROOT, file), "utf8") }),
);

describe("the tests run every hook the way husky runs it", () => {
  it("the installed husky calls the hook with the same flags as HUSKY_HOOK_ARGS", () => {
    const runner = readFileSync(
      join(ROOT, "node_modules", "husky", "husky"),
      "utf8",
    );

    expect(runner).toContain(`sh ${HUSKY_HOOK_ARGS.join(" ")} "$s" "$@"`);
  });

  it("every sh a test starts gets HUSKY_HOOK_ARGS, except the -c of a loose snippet and the mise wrapper that lint-staged runs with plain sh", () => {
    const offenders = testSources.flatMap(({ file, source }) =>
      [...source.matchAll(SH_SPAWN)]
        .map(([, target]) => target.trim())
        .filter(
          (target) =>
            target !== "...HUSKY_HOOK_ARGS" && !PLAIN_SH_TARGETS.has(target),
        )
        .map((target) => `${file}: ${target}`),
    );

    expect(offenders).toEqual([]);
  });
});
