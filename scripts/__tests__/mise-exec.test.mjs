import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "..", "mise-exec.sh");
const BASE_PATH = "/usr/bin:/bin";

let dir;
let home;

function fakeMise(folder) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "mise"),
    `#!/bin/sh\nprintf '%s|' "$0" "$@"\nexit 7\n`,
    { mode: 0o755 },
  );

  return join(folder, "mise");
}

function run(env, ...args) {
  return spawnSync("sh", [SCRIPT, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: BASE_PATH, HOME: home, ...env },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bcct-mise-exec-"));
  home = join(dir, "home");
  mkdirSync(home);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("scripts/mise-exec.sh", () => {
  it("runs the tool through the mise on the PATH and keeps its exit code", () => {
    const bin = join(dir, "bin");
    const mise = fakeMise(bin);

    const result = run(
      { PATH: `${bin}:${BASE_PATH}` },
      "typos",
      "--force-exclude",
      "a b.md",
    );

    expect(result.stdout).toBe(`${mise}|exec|--|typos|--force-exclude|a b.md|`);
    expect(result.status).toBe(7);
  });

  it("falls back to ~/.local/bin/mise, where the official installer puts it, when mise is not on the PATH", () => {
    const mise = fakeMise(join(home, ".local", "bin"));

    const result = run({}, "zizmor", "--offline");

    expect(result.stdout).toBe(`${mise}|exec|--|zizmor|--offline|`);
  });

  it("prefers the mise on the PATH over the one in ~/.local/bin", () => {
    const bin = join(dir, "bin");
    const onPath = fakeMise(bin);
    fakeMise(join(home, ".local", "bin"));

    expect(run({ PATH: `${bin}:${BASE_PATH}` }, "typos").stdout).toBe(
      `${onPath}|exec|--|typos|`,
    );
  });

  it("fails with the install instruction and the tool name when there is no mise", () => {
    const result = run({}, "actionlint");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "✖ actionlint runs through mise, which is not installed.",
    );
    expect(result.stderr).toContain(
      "https://mise.jdx.dev/installing-mise.html",
    );
    expect(result.stderr).toContain("mise trust && mise install");
  });
});
