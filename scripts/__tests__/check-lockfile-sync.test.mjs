import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkLockfileSync,
  formatReport,
  rootMirrorProblems,
  summarizeNpmCiError,
} from "../check-lockfile-sync.mjs";

const SCRIPT = join(import.meta.dirname, "..", "check-lockfile-sync.mjs");
const NPM_TIMEOUT = 30_000;

let dir;

function writePackage(manifest, lockRoot = manifest) {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "probe", version: "1.0.0", ...manifest }),
  );
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify({
      name: "probe",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "probe", version: "1.0.0", ...lockRoot } },
    }),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bcct-lockfile-sync-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("rootMirrorProblems", () => {
  it("finds nothing when every section of package.json matches the lock root", () => {
    expect(
      rootMirrorProblems(
        { dependencies: { a: "1.0.0" }, devDependencies: { b: "2.0.0" } },
        { dependencies: { a: "1.0.0" }, devDependencies: { b: "2.0.0" } },
      ),
    ).toEqual([]);
  });

  it("lists a changed version, a dependency missing from the lock and one only in the lock, sorted by name", () => {
    expect(
      rootMirrorProblems(
        { devDependencies: { c: "1.0.0", a: "2.0.0" } },
        { devDependencies: { a: "1.0.0", b: "1.0.0" } },
      ),
    ).toEqual([
      'devDependencies.a: package.json "2.0.0" × package-lock.json "1.0.0"',
      'devDependencies.b: package.json null × package-lock.json "1.0.0"',
      'devDependencies.c: package.json "1.0.0" × package-lock.json null',
    ]);
  });

  it("checks optional and peer dependencies too", () => {
    expect(
      rootMirrorProblems(
        {
          optionalDependencies: { o: "1.0.0" },
          peerDependencies: { p: "1.0.0" },
        },
        {},
      ),
    ).toEqual([
      'optionalDependencies.o: package.json "1.0.0" × package-lock.json null',
      'peerDependencies.p: package.json "1.0.0" × package-lock.json null',
    ]);
  });
});

describe("summarizeNpmCiError", () => {
  it("keeps the headline of the npm error and the Invalid and Missing details, without the code and log lines", () => {
    const stderr = [
      "npm error code EUSAGE",
      "npm error",
      "npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync.",
      "npm error",
      "npm error Invalid: lock file's a@1.0.0 does not satisfy a@2.0.0",
      "npm error Missing: b@1.0.0 from lock file",
      "npm error A complete log of this run can be found in: /tmp/x.log",
      "npm warn something else",
    ].join("\n");

    expect(summarizeNpmCiError(stderr)).toEqual([
      "`npm ci` can only install packages when your package.json and package-lock.json are in sync.",
      "Invalid: lock file's a@1.0.0 does not satisfy a@2.0.0",
      "Missing: b@1.0.0 from lock file",
    ]);
  });

  it("returns nothing without npm error lines", () => {
    expect(summarizeNpmCiError("npm warn deprecated\n")).toEqual([]);
  });
});

describe("checkLockfileSync", { timeout: NPM_TIMEOUT }, () => {
  it("accepts a package whose lock is in sync", async () => {
    writePackage({});

    expect(await checkLockfileSync(dir)).toEqual({ dir, problems: [] });
  });

  it("reports the mismatch between package.json and the lock root before running npm", async () => {
    writePackage(
      { devDependencies: { vitest: "5.0.5" } },
      { devDependencies: { vitest: "5.0.4" } },
    );

    expect((await checkLockfileSync(dir)).problems).toEqual([
      'devDependencies.vitest: package.json "5.0.5" × package-lock.json "5.0.4"',
    ]);
  });

  it("reports what npm ci finds when the root matches but the lock does not hold the package", async () => {
    writePackage({ devDependencies: { "left-pad": "1.3.0" } });

    const { problems } = await checkLockfileSync(dir);

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toMatch(/left-pad/u);
  });

  it("skips a folder without package.json and reports a missing or unreadable lock", async () => {
    expect(await checkLockfileSync(dir)).toEqual({ dir, problems: [] });

    writeFileSync(join(dir, "package.json"), "{}");
    expect((await checkLockfileSync(dir)).problems).toEqual([
      "package-lock.json is missing",
    ]);

    writeFileSync(join(dir, "package-lock.json"), "{");
    expect((await checkLockfileSync(dir)).problems).toEqual([
      "package-lock.json is unreadable",
    ]);
  });
});

describe("formatReport", () => {
  it("names each folder out of sync with its problems and how to fix it, and skips the folders in sync", () => {
    const report = formatReport(
      [
        { dir: "/repo", problems: ["devDependencies.a: x"] },
        { dir: "/repo/plugins/x", problems: [] },
      ],
      "/repo",
    );

    expect(report).toBe(
      [
        ".: package.json and package-lock.json are out of sync",
        "  - devDependencies.a: x",
        "  Run npm install to update the lock, then stage both files.",
      ].join("\n"),
    );
  });
});

describe("check-lockfile-sync.mjs", { timeout: NPM_TIMEOUT }, () => {
  it("checks the current folder by default and exits 1 with the report", () => {
    writePackage(
      { dependencies: { a: "2.0.0" } },
      { dependencies: { a: "1.0.0" } },
    );

    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".: package.json and package-lock.json are out of sync",
    );
  });

  it("exits 0 without output when the lock is in sync", () => {
    writePackage({});

    const result = spawnSync(process.execPath, [SCRIPT, "."], {
      cwd: dir,
      encoding: "utf8",
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
