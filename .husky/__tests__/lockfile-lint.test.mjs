import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const LOCKFILE_LINT = join(ROOT, "node_modules", ".bin", "lockfile-lint");
const INTEGRITY = `sha512-${"A".repeat(86)}==`;

let dir;

function lockWith(packages) {
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify({
      name: "probe",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "probe", version: "1.0.0" }, ...packages },
    }),
  );
}

function entry(resolved, integrity = INTEGRITY) {
  return { version: "1.0.0", resolved, integrity, dev: true };
}

function lint() {
  return spawnSync(LOCKFILE_LINT, [], { cwd: dir, encoding: "utf8" });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bcct-lockfile-lint-"));
  copyFileSync(
    join(ROOT, ".lockfile-lintrc.json"),
    join(dir, ".lockfile-lintrc.json"),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe(".lockfile-lintrc.json", () => {
  it("accepts packages resolved over https from the public npm registry with a sha512 integrity", () => {
    lockWith({
      "node_modules/left-pad": entry(
        "https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz",
      ),
    });

    expect(lint().status).toBe(0);
  });

  it.each([
    [
      "another registry",
      "https://npm.internal.example/left-pad/-/left-pad-1.0.0.tgz",
    ],
    ["plain http", "http://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz"],
    ["a git source", "git+ssh://git@github.com/owner/left-pad.git#abc"],
    [
      "a tarball named after another package",
      "https://registry.npmjs.org/evil/-/evil-1.0.0.tgz",
    ],
  ])("refuses a package resolved from %s", (_label, resolved) => {
    lockWith({ "node_modules/left-pad": entry(resolved) });

    expect(lint().status).not.toBe(0);
  });

  it("refuses an integrity that is not a full sha512", () => {
    lockWith({
      "node_modules/left-pad": entry(
        "https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz",
        "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      ),
    });

    expect(lint().status).not.toBe(0);
  });

  it("passes on the lock of this repository", () => {
    const result = spawnSync(LOCKFILE_LINT, [], {
      cwd: ROOT,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
  });
});
