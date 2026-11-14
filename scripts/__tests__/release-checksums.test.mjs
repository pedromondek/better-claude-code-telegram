import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { expectedHash } from "../../npm/shim/shim.mjs";
import { TARGETS } from "../release-binary.mjs";
import { appendChecksums, run } from "../release-checksums.mjs";
import { CHECKSUMS_FILE } from "../release-order.mjs";
import { VERSION_FILES, setVersion } from "../version.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const VERSION = "0.2.0";
const HEADER = "# version asset sha256";

let root;

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function project(version = VERSION) {
  for (const file of VERSION_FILES) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(ROOT, file), join(root, file));
  }
  setVersion(root, version);
  mkdirSync(join(root, "dist"), { recursive: true });
  for (const { asset } of TARGETS) {
    writeFileSync(join(root, "dist", asset), `binary ${asset}`);
    writeFileSync(
      join(root, "dist", `${asset}.sha256`),
      `${sha256(`binary ${asset}`)}  ${asset}\n`,
    );
  }
}

function checksums() {
  return readFileSync(join(root, CHECKSUMS_FILE), "utf8");
}

function append() {
  return appendChecksums({ root, assetsDir: join(root, "dist") });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bcct-release-checksums-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("appendChecksums", () => {
  it("creates the file with its header and one line per asset of the version, in the order of the build", () => {
    project();

    expect(append()).toEqual(TARGETS.map(({ asset }) => asset));
    expect(checksums()).toBe(
      [
        HEADER,
        ...TARGETS.map(
          ({ asset }) => `${VERSION} ${asset} ${sha256(`binary ${asset}`)}`,
        ),
        "",
      ].join("\n"),
    );
  });

  it("only appends, keeping the lines of the versions released before", () => {
    project();
    const earlier = `${HEADER}\n0.1.0 bcct-linux-x64 ${"a".repeat(64)}\n`;

    mkdirSync(dirname(join(root, CHECKSUMS_FILE)), { recursive: true });
    writeFileSync(join(root, CHECKSUMS_FILE), earlier);
    append();

    expect(checksums().startsWith(earlier)).toBe(true);
    expect(checksums().split("\n")).toHaveLength(2 + TARGETS.length + 1);
  });

  it("adds the missing line break before appending to a file that ends without one", () => {
    project();
    mkdirSync(dirname(join(root, CHECKSUMS_FILE)), { recursive: true });
    writeFileSync(
      join(root, CHECKSUMS_FILE),
      `${HEADER}\n0.1.0 bcct-linux-x64 ${"a".repeat(64)}`,
    );

    append();

    expect(checksums()).toContain(
      `0.1.0 bcct-linux-x64 ${"a".repeat(64)}\n${VERSION} bcct-linux-x64 `,
    );
  });

  it("writes lines that the shim and the bcct update read back", () => {
    project();
    append();

    for (const { asset } of TARGETS) {
      expect(expectedHash(checksums(), VERSION, asset)).toBe(
        sha256(`binary ${asset}`),
      );
    }
    expect(
      readFileSync(join(ROOT, "rust/crates/bcct/src/update.rs"), "utf8"),
    ).toContain("(found.0 == version && found.1 == asset)");
  });

  it("refuses a version that already has lines, rewriting nothing", () => {
    project();
    append();
    const before = checksums();

    expect(() => append()).toThrow(
      `checksums.txt already has lines for ${VERSION}; the file only grows`,
    );
    expect(checksums()).toBe(before);
  });

  it("refuses an asset whose sha256 file does not match it, writing nothing", () => {
    project();
    writeFileSync(join(root, "dist/bcct-darwin-arm64"), "tampered");

    expect(() => append()).toThrow(
      "bcct-darwin-arm64 does not match bcct-darwin-arm64.sha256",
    );
    expect(existsSync(join(root, CHECKSUMS_FILE))).toBe(false);
  });

  it.each([
    ["the binary", "bcct-win32-x64.exe"],
    ["the sha256 file", "bcct-win32-x64.exe.sha256"],
  ])("refuses a missing file (%s)", (_case, file) => {
    project();
    rmSync(join(root, "dist", file));

    expect(() => append()).toThrow(
      `${file} is missing from ${join(root, "dist")}`,
    );
  });

  it("refuses a sha256 file that names another asset", () => {
    project();
    writeFileSync(
      join(root, "dist/bcct-linux-arm64.sha256"),
      `${sha256("binary bcct-linux-arm64")}  bcct-linux-x64\n`,
    );

    expect(() => append()).toThrow(
      "bcct-linux-arm64.sha256 names bcct-linux-x64, not bcct-linux-arm64",
    );
  });

  it("refuses version files that disagree", () => {
    project();
    const plugin = join(root, "plugins/bcct/.claude-plugin/plugin.json");

    writeFileSync(
      plugin,
      readFileSync(plugin, "utf8").replace(
        /"version": "[^"]+"/u,
        '"version": "9.9.9"',
      ),
    );

    expect(() => append()).toThrow(
      "the version files disagree: npm run release:version -- check names them",
    );
  });
});

describe("run", () => {
  function runWith(args) {
    const out = [];
    const err = [];
    const code = run(args, {
      root,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });

    return { code, out, err };
  }

  it("appends the lines and says how many", () => {
    project();

    expect(runWith(["dist"])).toEqual({
      code: 0,
      out: [
        `✓ ${TARGETS.length} lines of v${VERSION} added to ${CHECKSUMS_FILE}`,
      ],
      err: [],
    });
  });

  it("exits 1 with the reason", () => {
    project();
    append();

    expect(runWith(["dist"])).toEqual({
      code: 1,
      out: [],
      err: [
        `✗ checksums.txt already has lines for ${VERSION}; the file only grows`,
      ],
    });
  });

  it.each([[[]], [["a", "b"]]])("a usage error exits 2 (%j)", (args) => {
    expect(runWith(args)).toEqual({
      code: 2,
      out: [],
      err: ["usage: npm run release:checksums -- <assets folder>"],
    });
  });

  it("is the release:checksums npm script", () => {
    const { scripts } = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    );

    expect(scripts["release:checksums"]).toBe(
      "node scripts/release-checksums.mjs",
    );
  });
});
