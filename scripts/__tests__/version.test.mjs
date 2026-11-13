import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  VERSION_FILES,
  checkVersions,
  nextVersion,
  parseVersion,
  readVersions,
  run,
  setVersion,
} from "../version.mjs";

const ROOT = join(import.meta.dirname, "..", "..");

let root;

function copyProject() {
  for (const file of VERSION_FILES) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(ROOT, file), join(root, file));
  }
}

function read(file) {
  return readFileSync(join(root, file), "utf8");
}

function changedLines(file, before) {
  const after = read(file).split("\n");

  return before
    .split("\n")
    .map((line, index) => [line, after[index]])
    .filter(([was, now]) => was !== now);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bcct-version-"));
  copyProject();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("parseVersion", () => {
  it.each([
    ["0.1.0", { major: 0, minor: 1, patch: 0, stage: null, number: null }],
    [
      "0.2.0-alpha.3",
      { major: 0, minor: 2, patch: 0, stage: "alpha", number: 3 },
    ],
    ["1.4.2-rc.1", { major: 1, minor: 4, patch: 2, stage: "rc", number: 1 }],
  ])("reads %s", (text, version) => {
    expect(parseVersion(text)).toEqual(version);
  });

  it.each([
    "v0.1.0",
    "0.1",
    "0.1.0-dev.1",
    "0.1.0-alpha",
    "0.1.0-alpha.0",
    "01.1.0",
  ])("refuses %s", (text) => {
    expect(() => parseVersion(text)).toThrow(`invalid version: ${text}`);
  });
});

describe("nextVersion", () => {
  it.each([
    ["0.1.0-alpha.1", "alpha", "0.1.0-alpha.2"],
    ["0.1.0-alpha.2", "beta", "0.1.0-beta.1"],
    ["0.1.0-alpha.2", "rc", "0.1.0-rc.1"],
    ["0.1.0-beta.4", "rc", "0.1.0-rc.1"],
    ["0.1.0-rc.2", "rc", "0.1.0-rc.3"],
    ["0.1.0-rc.2", "stable", "0.1.0"],
    ["0.1.0-alpha.1", "stable", "0.1.0"],
  ])("goes from %s to the %s stage as %s", (current, stage, next) => {
    expect(nextVersion(current, stage, "9.9.9")).toBe(next);
  });

  it("refuses to go back to an earlier stage", () => {
    expect(() => nextVersion("0.1.0-rc.1", "beta", "9.9.9")).toThrow(
      "cannot go back from rc to beta",
    );
  });

  it("refuses a stage it does not know", () => {
    expect(() => nextVersion("0.1.0-rc.1", "dev", "9.9.9")).toThrow(
      "unknown stage: dev (use alpha, beta, rc or stable)",
    );
  });

  it("from a stable version, a fix goes straight to the next stable, as git-cliff bumps it", () => {
    expect(nextVersion("0.1.0", "stable", "0.1.1")).toBe("0.1.1");
  });

  it("from a stable version, a feature opens the first pre-release of the bumped version", () => {
    expect(nextVersion("0.1.0", "alpha", "0.2.0")).toBe("0.2.0-alpha.1");
    expect(nextVersion("0.1.0", "beta", "0.2.0")).toBe("0.2.0-beta.1");
  });

  it("from a stable version, refuses a bump that does not move forward", () => {
    expect(() => nextVersion("0.2.0", "stable", "0.2.0")).toThrow(
      "nothing to release after 0.2.0 (to pick the version by hand, use set <version>)",
    );
  });
});

describe("the version files", () => {
  it("are the binary, the npm packages and their lock, and every plugin", () => {
    expect(VERSION_FILES).toEqual([
      "rust/Cargo.toml",
      "rust/Cargo.lock",
      "package.json",
      "package-lock.json",
      "plugins/telegram/package.json",
      "plugins/telegram/.claude-plugin/plugin.json",
      "plugins/telegram-hooks/.claude-plugin/plugin.json",
      "plugins/bcct/.claude-plugin/plugin.json",
    ]);
  });

  it("all carry the same version in the repository", () => {
    expect(checkVersions(ROOT)).toEqual([]);
  });

  it("set writes the version in every file and changes only the version lines", () => {
    const before = Object.fromEntries(
      VERSION_FILES.map((file) => [file, read(file)]),
    );
    const current = readVersions(root)[0].version;

    setVersion(root, "0.1.0-alpha.1");

    expect(new Set(readVersions(root).map(({ version }) => version))).toEqual(
      new Set(["0.1.0-alpha.1"]),
    );
    for (const file of VERSION_FILES) {
      const changes = changedLines(file, before[file]);
      const expected = file === "package-lock.json" ? 2 : 1;

      expect({ file, changes: changes.length }).toEqual({
        file,
        changes: expected,
      });
      for (const [was, now] of changes) {
        expect(now).toBe(was.replace(current, "0.1.0-alpha.1"));
      }
    }
  });

  it("set refuses an invalid version and writes nothing", () => {
    const before = read("package.json");

    expect(() => setVersion(root, "0.1.0-dev.1")).toThrow(
      "invalid version: 0.1.0-dev.1",
    );
    expect(read("package.json")).toBe(before);
  });

  it("check names each file that differs from the binary", () => {
    setVersion(root, "0.1.0-alpha.1");
    cpSync(join(ROOT, "package.json"), join(root, "package.json"));

    expect(checkVersions(root)).toEqual([
      { file: "package.json", version: readVersions(ROOT)[0].version },
    ]);
  });
});

describe("run", () => {
  function captured(args, bumped = () => "0.2.0") {
    const out = [];
    const err = [];
    const code = run(args, {
      root,
      bumped,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });

    return { code, out, err };
  }

  it("check exits 0 and says the version when every file agrees", () => {
    const current = readVersions(root)[0].version;

    expect(captured(["check"])).toEqual({
      code: 0,
      out: [`✓ every file is on ${current}`],
      err: [],
    });
  });

  it("check exits 1 and lists the files that differ", () => {
    setVersion(root, "0.1.0-alpha.1");
    cpSync(join(ROOT, "package.json"), join(root, "package.json"));

    const result = captured(["check"]);

    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      "✗ the version differs from rust/Cargo.toml (0.1.0-alpha.1):",
      `  package.json: ${readVersions(ROOT)[0].version}`,
    ]);
  });

  it("set writes the version and prints it", () => {
    expect(captured(["set", "0.1.0-alpha.1"])).toEqual({
      code: 0,
      out: ["✓ version set to 0.1.0-alpha.1"],
      err: [],
    });
    expect(checkVersions(root)).toEqual([]);
  });

  it("next prints the next version for the stage, asking git-cliff only from a stable version", () => {
    setVersion(root, "0.1.0-alpha.1");
    let asked = 0;

    expect(
      captured(["next", "beta"], () => {
        asked += 1;

        return "0.2.0";
      }),
    ).toEqual({ code: 0, out: ["0.1.0-beta.1"], err: [] });
    expect(asked).toBe(0);
  });

  it("next uses the git-cliff bump from a stable version", () => {
    setVersion(root, "0.1.0");

    expect(captured(["next", "alpha"])).toEqual({
      code: 0,
      out: ["0.2.0-alpha.1"],
      err: [],
    });
  });

  it("a usage error exits 2 with the usage", () => {
    expect(captured(["bump"])).toEqual({
      code: 2,
      out: [],
      err: [
        "usage: npm run release:version -- check | set <version> | next <alpha|beta|rc|stable>",
      ],
    });
  });

  it("is the release:version npm script", () => {
    const scripts = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ).scripts;

    expect(scripts["release:version"]).toBe("node scripts/version.mjs");
  });

  it("an invalid input exits 1 with the reason", () => {
    expect(captured(["set", "1.0"])).toEqual({
      code: 1,
      out: [],
      err: ["✗ invalid version: 1.0"],
    });
  });
});
