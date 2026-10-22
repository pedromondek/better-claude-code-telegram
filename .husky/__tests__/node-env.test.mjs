import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HUSKY_HOOK_ARGS } from "./support/husky-hook.mjs";

const NODE_ENV = join(import.meta.dirname, "..", "lib", "node-env.sh");
const BASE_PATH = "/usr/bin:/bin";

let dir;
let home;
let log;

function fakeFnm(folder, { useExitCode = 0 } = {}) {
  mkdirSync(folder, { recursive: true });
  const fnm = join(folder, "fnm");
  writeFileSync(
    fnm,
    [
      "#!/bin/sh",
      `echo "fnm $*" >> "${log}"`,
      '[ "$1" = env ] && echo "export FNM_ACTIVE=1"',
      `[ "$1" = use ] && exit ${useExitCode}`,
      "exit 0",
    ].join("\n"),
  );
  chmodSync(fnm, 0o755);
}

function fakeNvm() {
  mkdirSync(join(home, ".nvm"), { recursive: true });
  writeFileSync(
    join(home, ".nvm", "nvm.sh"),
    `nvm() { echo "nvm $*" >> "${log}"; }\n`,
  );
}

function sourceNodeEnv(extraEnv = {}) {
  const script = join(dir, "hook.sh");
  writeFileSync(
    script,
    [
      `. "${NODE_ENV}"`,
      'echo "path=$PATH"',
      'echo "active=${FNM_ACTIVE:-}"',
    ].join("\n"),
  );

  const result = spawnSync("sh", [...HUSKY_HOOK_ARGS, script], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: BASE_PATH, HOME: home, ...extraEnv },
  });

  return {
    ...result,
    calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bcct-node-env-"));
  home = join(dir, "home");
  log = join(dir, "calls.log");
  mkdirSync(home);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe(".husky/lib/node-env.sh", () => {
  it("puts the fnm of FNM_DIR on the PATH, loads its env and switches to the .nvmrc version", () => {
    const fnmDir = join(dir, "custom-fnm");
    fakeFnm(fnmDir);

    const result = sourceNodeEnv({ FNM_DIR: fnmDir });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`path=${fnmDir}:${BASE_PATH}\n`);
    expect(result.stdout).toContain("active=1\n");
    expect(result.calls).toEqual(["fnm env", "fnm use --install-if-missing"]);
  });

  it.each([
    [".local/share/fnm", join(".local", "share", "fnm")],
    [".fnm", ".fnm"],
  ])("finds fnm in ~/%s when FNM_DIR is not set", (_label, folder) => {
    fakeFnm(join(home, folder));

    const result = sourceNodeEnv();

    expect(result.stdout).toContain(
      `path=${join(home, folder)}:${BASE_PATH}\n`,
    );
    expect(result.calls).toEqual(["fnm env", "fnm use --install-if-missing"]);
  });

  it("prefers FNM_DIR over the default folders", () => {
    const fnmDir = join(dir, "custom-fnm");
    fakeFnm(fnmDir);
    fakeFnm(join(home, ".fnm"));

    expect(sourceNodeEnv({ FNM_DIR: fnmDir }).stdout).toContain(
      `path=${fnmDir}:${BASE_PATH}\n`,
    );
  });

  it("keeps the hook running when fnm cannot switch the version", () => {
    fakeFnm(join(home, ".fnm"), { useExitCode: 1 });

    const result = sourceNodeEnv();

    expect(result.status).toBe(0);
    expect(result.calls).toEqual(["fnm env", "fnm use --install-if-missing"]);
  });

  it("falls back to nvm when there is no fnm", () => {
    fakeNvm();

    const result = sourceNodeEnv();

    expect(result.status).toBe(0);
    expect(result.calls).toEqual(["nvm use"]);
  });

  it("prefers fnm when both are installed", () => {
    fakeFnm(join(home, ".fnm"));
    fakeNvm();

    expect(sourceNodeEnv().calls).toEqual([
      "fnm env",
      "fnm use --install-if-missing",
    ]);
  });

  it("leaves the PATH as it is when there is no version manager", () => {
    const result = sourceNodeEnv();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`path=${BASE_PATH}\n`);
    expect(result.calls).toEqual([]);
  });
});
