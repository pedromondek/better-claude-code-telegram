import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXTRA_HOOKS, installExtraHooks } from "../husky-extra-hooks.mjs";

const HUSKY_WRAPPER = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"';

let huskyDir;

function installHusky() {
  mkdirSync(join(huskyDir, "_"));
  writeFileSync(join(huskyDir, "_", "pre-commit"), HUSKY_WRAPPER, {
    mode: 0o755,
  });
}

beforeEach(() => {
  huskyDir = mkdtempSync(join(tmpdir(), "bcct-husky-extra-hooks-"));
});

afterEach(() => {
  rmSync(huskyDir, { recursive: true, force: true });
});

describe("installExtraHooks", () => {
  it("installs reference-transaction, which husky does not generate", () => {
    expect(EXTRA_HOOKS).toEqual(["reference-transaction"]);
  });

  it("writes into the _ folder of husky the same wrapper as the husky hooks, executable", () => {
    installHusky();

    expect(installExtraHooks(huskyDir)).toEqual(["reference-transaction"]);

    const wrapper = join(huskyDir, "_", "reference-transaction");

    expect(readFileSync(wrapper, "utf8")).toBe(HUSKY_WRAPPER);
    expect(statSync(wrapper).mode & 0o777).toBe(0o755);
  });

  it("gives the same result when it runs again", () => {
    installHusky();

    installExtraHooks(huskyDir);
    installExtraHooks(huskyDir);

    expect(
      readFileSync(join(huskyDir, "_", "reference-transaction"), "utf8"),
    ).toBe(HUSKY_WRAPPER);
  });

  it("does nothing without husky installed (HUSKY=0, CI or a production install)", () => {
    expect(installExtraHooks(huskyDir)).toEqual([]);
    expect(existsSync(join(huskyDir, "_"))).toBe(false);
  });
});
