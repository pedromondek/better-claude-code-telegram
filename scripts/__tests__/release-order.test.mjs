import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CHECKSUMS_FILE,
  FIRST_BASE,
  checkOrder,
  compareVersions,
  ledgerVersions,
  releasedVersions,
} from "../release-order.mjs";

const ROOT = join(import.meta.dirname, "..", "..");

let root;

function write(file, text) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bcct-release-order-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("compareVersions", () => {
  it.each([
    ["0.1.0", "0.1.1"],
    ["0.1.9", "0.2.0"],
    ["0.9.9", "1.0.0"],
    ["0.10.0", "0.11.0"],
    ["0.2.0-alpha.9", "0.2.0-alpha.10"],
    ["0.2.0-alpha.3", "0.2.0-beta.1"],
    ["0.2.0-beta.4", "0.2.0-rc.1"],
    ["0.2.0-rc.9", "0.2.0"],
    ["0.2.0", "0.2.1-alpha.1"],
  ])("puts %s before %s, as semver orders them", (lower, higher) => {
    expect(compareVersions(lower, higher)).toBeLessThan(0);
    expect(compareVersions(higher, lower)).toBeGreaterThan(0);
  });

  it("finds a version equal to itself", () => {
    expect(compareVersions("0.2.0-beta.1", "0.2.0-beta.1")).toBe(0);
  });
});

describe("checkOrder", () => {
  it.each([
    ["0.2.1", ["0.2.0"], "patch"],
    ["0.3.0", ["0.2.0"], "minor"],
    ["1.0.0", ["0.2.0"], "major"],
    ["0.2.1-alpha.1", ["0.2.0"], "patch"],
    ["0.3.0-beta.1", ["0.2.0"], "minor"],
    ["1.5.0", ["1.4.2", "0.9.0"], "minor"],
    ["2.0.0-rc.1", ["1.4.2"], "major"],
  ])(
    "lets %s open the next base after %j, as a %s",
    (version, released, bump) => {
      expect(checkOrder(version, released)).toEqual({
        problem: null,
        bump,
        opensBase: true,
        approval: bump !== "patch",
      });
    },
  );

  it.each([
    ["0.2.2", ["0.2.0"], "0.2.1, 0.3.0, 1.0.0"],
    ["0.4.0", ["0.2.0"], "0.2.1, 0.3.0, 1.0.0"],
    ["0.3.1", ["0.2.0"], "0.2.1, 0.3.0, 1.0.0"],
    ["2.0.0", ["0.2.0"], "0.2.1, 0.3.0, 1.0.0"],
    ["1.1.0", ["0.2.0"], "0.2.1, 0.3.0, 1.0.0"],
    ["1.6.0", ["1.4.2"], "1.4.3, 1.5.0, 2.0.0"],
    ["0.4.0-alpha.1", ["0.2.0"], "0.2.1, 0.3.0, 1.0.0"],
  ])(
    "refuses %s after %j, which skips a version",
    (version, released, next) => {
      expect(checkOrder(version, released).problem).toBe(
        `v${version} skips a version: the next one has the base ${next}`,
      );
    },
  );

  it("keeps an open pre-release line until its stable, without opening another base", () => {
    const released = ["0.2.0", "0.3.0-alpha.1"];

    expect(checkOrder("0.4.0-alpha.1", released).problem).toBe(
      "v0.4.0-alpha.1 skips a version: the next one has the base 0.3.0",
    );
    expect(checkOrder("1.0.0", released).problem).toBe(
      "v1.0.0 skips a version: the next one has the base 0.3.0",
    );
  });

  it.each([
    ["0.3.0-alpha.2", false],
    ["0.3.0-beta.1", false],
    ["0.3.0-rc.1", false],
    ["0.3.0", true],
  ])(
    "inside the open line of a minor, asks for approval only on its stable (%s)",
    (version, approval) => {
      expect(checkOrder(version, ["0.2.0", "0.3.0-alpha.1"])).toEqual({
        problem: null,
        bump: "minor",
        opensBase: false,
        approval,
      });
    },
  );

  it("inside the open line of a patch, never asks for approval", () => {
    expect(checkOrder("0.2.1", ["0.2.0", "0.2.1-beta.1"])).toEqual({
      problem: null,
      bump: "patch",
      opensBase: false,
      approval: false,
    });
  });

  it("asks for approval once when a minor opens straight on its stable", () => {
    expect(checkOrder("0.3.0", ["0.2.0"])).toEqual({
      problem: null,
      bump: "minor",
      opensBase: true,
      approval: true,
    });
  });

  it.each([
    ["0.2.0", ["0.2.0"]],
    ["0.3.0-alpha.1", ["0.2.0", "0.3.0-alpha.1"]],
  ])("refuses %s, which already exists", (version, released) => {
    expect(checkOrder(version, released).problem).toBe(
      `v${version} already exists`,
    );
  });

  it.each([
    ["0.2.0-alpha.1", ["0.2.0"], "0.2.0"],
    ["0.1.1", ["0.1.0", "0.2.0"], "0.2.0"],
    ["0.2.1", ["0.2.0", "0.3.0-beta.1"], "0.3.0-beta.1"],
    ["0.3.0-alpha.2", ["0.2.0", "0.3.0-beta.1"], "0.3.0-beta.1"],
  ])(
    "refuses %s, which does not come after everything released",
    (version, released, highest) => {
      expect(checkOrder(version, released).problem).toBe(
        `v${version} does not come after v${highest}, the highest version released`,
      );
    },
  );

  it("opens the first base of the project with nothing released, asking for approval", () => {
    expect(checkOrder(`${FIRST_BASE}-alpha.1`, [])).toEqual({
      problem: null,
      bump: "minor",
      opensBase: true,
      approval: true,
    });
  });

  it.each(["0.2.0", "1.0.0", "0.1.1"])(
    "refuses %s as the first version, which is not the first base",
    (version) => {
      expect(checkOrder(version, []).problem).toBe(
        `v${version} skips a version: the next one has the base ${FIRST_BASE}`,
      );
    },
  );

  it("keeps the first base in step with the initial tag of git-cliff", () => {
    expect(readFileSync(join(ROOT, "cliff.toml"), "utf8")).toContain(
      `initial_tag = "v${FIRST_BASE}"`,
    );
  });

  it("refuses an invalid version", () => {
    expect(() => checkOrder("0.2", [])).toThrow("invalid version: 0.2");
  });
});

describe("releasedVersions", () => {
  it("joins every source, sorted and without repeats, and leaves out names outside the version format", () => {
    expect(
      releasedVersions({
        tags: ["0.2.0", "0.1.0", "x"],
        releases: ["0.2.0", "0.1.0"],
        npm: ["0.2.0", "0.1.0", "0.3.0-alpha.1"],
        ledger: ["0.2.0", "0.1.0", "0.3.0-alpha.1", "0.3.0-alpha.2"],
      }).versions,
    ).toEqual(["0.1.0", "0.2.0", "0.3.0-alpha.1", "0.3.0-alpha.2"]);
  });

  it("warns about a version that the tags, the Releases and npm do not all have", () => {
    expect(
      releasedVersions({
        tags: ["0.1.0", "0.2.0"],
        releases: ["0.1.0", "0.2.0"],
        npm: ["0.1.0", "0.3.0-alpha.1"],
        ledger: [],
      }).warnings,
    ).toEqual([
      "v0.2.0 is in the tags and the Releases, but not in npm",
      "v0.3.0-alpha.1 is in npm, but not in the tags and the Releases",
    ]);
  });

  it("does not warn when every public source agrees", () => {
    expect(
      releasedVersions({
        tags: ["0.1.0"],
        releases: ["0.1.0"],
        npm: ["0.1.0"],
        ledger: [],
      }).warnings,
    ).toEqual([]);
  });
});

describe("ledgerVersions", () => {
  it("reads the versions of the notes in docs/releases and of the checksums file", () => {
    write("docs/releases/0.1.0/alpha.1.md", "notes");
    write("docs/releases/0.1.0/stable.md", "notes");
    write("docs/releases/0.2.0/rc.2.md", "notes");
    write("docs/releases/README.md", "not a version");
    write(
      CHECKSUMS_FILE,
      [
        "# version asset sha256",
        "0.1.0 bcct-linux-x64 aaa",
        "0.1.0 bcct-darwin-arm64 bbb",
        "0.2.0-beta.1 bcct-linux-x64 ccc",
        "",
      ].join("\n"),
    );

    expect(ledgerVersions(root).toSorted()).toEqual(
      ["0.1.0", "0.1.0-alpha.1", "0.2.0-beta.1", "0.2.0-rc.2"].toSorted(),
    );
  });

  it("is empty in a repository with neither", () => {
    expect(ledgerVersions(root)).toEqual([]);
  });

  it("reads the checksums file the bcct update reads", () => {
    expect(CHECKSUMS_FILE).toBe("plugins/telegram-hooks/checksums.txt");
    expect(
      readFileSync(join(ROOT, "rust/crates/bcct/src/update.rs"), "utf8"),
    ).toContain('const CHECKSUMS_FILE: &str = "checksums.txt";');
  });
});
