import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TARGETS } from "../release-binary.mjs";
import { CHECKSUMS_FILE } from "../release-order.mjs";
import { buildPackages, run } from "../release-npm.mjs";
import { VERSION_FILES, setVersion } from "../version.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const VERSION = "0.2.0";
const SHIM_FILES = [
  "npm/shim/shim.mjs",
  "npm/shim/shim.constants.mjs",
  "npm/shim/bin/better-claude-code-telegram.mjs",
];

let root;

function copy(file) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  cpSync(join(ROOT, file), join(root, file));
}

function project({ checksums = true } = {}) {
  for (const file of [...VERSION_FILES, ...SHIM_FILES, "LICENSE", "NOTICE"]) {
    copy(file);
  }
  setVersion(root, VERSION);

  const lines = ["# version asset sha256"];

  for (const { asset } of TARGETS) {
    const bytes = Buffer.from(`binary ${asset}`);

    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets", asset), bytes);
    lines.push(
      `${VERSION} ${asset} ${createHash("sha256").update(bytes).digest("hex")}`,
    );
  }

  if (checksums) {
    mkdirSync(dirname(join(root, CHECKSUMS_FILE)), { recursive: true });
    writeFileSync(join(root, CHECKSUMS_FILE), `${lines.join("\n")}\n`);
  }
}

function manifest(name) {
  return JSON.parse(
    readFileSync(join(root, "dist/npm", name, "package.json"), "utf8"),
  );
}

function build() {
  return buildPackages({
    root,
    assetsDir: join(root, "assets"),
    outDir: join(root, "dist/npm"),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bcct-release-npm-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("buildPackages", () => {
  it("builds the shim and the 6 platform packages, all on the project version", () => {
    project();

    expect(build()).toEqual([
      "@pedromondek/better-claude-code-telegram",
      "@pedromondek/better-claude-code-telegram-linux-x64",
      "@pedromondek/better-claude-code-telegram-linux-arm64",
      "@pedromondek/better-claude-code-telegram-darwin-arm64",
      "@pedromondek/better-claude-code-telegram-darwin-x64",
      "@pedromondek/better-claude-code-telegram-win32-x64",
      "@pedromondek/better-claude-code-telegram-win32-arm64",
    ]);
  });

  it("gives the shim the metadata of the repository, its bin, the exact platform versions as optional dependencies and the files it ships", () => {
    project();
    build();

    const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const shim = manifest("@pedromondek/better-claude-code-telegram");

    expect(shim).toEqual({
      name: "@pedromondek/better-claude-code-telegram",
      version: VERSION,
      description: source.description,
      keywords: source.keywords,
      homepage: source.homepage,
      bugs: source.bugs,
      repository: source.repository,
      license: source.license,
      author: source.author,
      type: "module",
      engines: source.engines,
      bin: {
        "better-claude-code-telegram": "bin/better-claude-code-telegram.mjs",
      },
      files: ["bin/", "shim.mjs", "shim.constants.mjs", "checksums.txt"],
      optionalDependencies: Object.fromEntries(
        [
          "linux-x64",
          "linux-arm64",
          "darwin-arm64",
          "darwin-x64",
          "win32-x64",
          "win32-arm64",
        ].map((name) => [
          `@pedromondek/better-claude-code-telegram-${name}`,
          VERSION,
        ]),
      ),
    });
    expect(shim).not.toHaveProperty("private");
    expect(shim).not.toHaveProperty("scripts");
    expect(shim).not.toHaveProperty("devDependencies");
  });

  it("copies the shim code, the checksums.txt of the release and the license into the shim", () => {
    project();
    build();

    const dir = join(root, "dist/npm/@pedromondek/better-claude-code-telegram");

    for (const [published, source] of [
      ["shim.mjs", "npm/shim/shim.mjs"],
      ["shim.constants.mjs", "npm/shim/shim.constants.mjs"],
      [
        "bin/better-claude-code-telegram.mjs",
        "npm/shim/bin/better-claude-code-telegram.mjs",
      ],
      ["checksums.txt", CHECKSUMS_FILE],
      ["LICENSE", "LICENSE"],
      ["NOTICE", "NOTICE"],
    ]) {
      expect({
        published,
        text: readFileSync(join(dir, published), "utf8"),
      }).toEqual({
        published,
        text: readFileSync(join(root, source), "utf8"),
      });
    }
  });

  it.each([
    ["linux-x64", "linux", "x64", "bcct", "bcct-linux-x64"],
    ["linux-arm64", "linux", "arm64", "bcct", "bcct-linux-arm64"],
    ["darwin-arm64", "darwin", "arm64", "bcct", "bcct-darwin-arm64"],
    ["darwin-x64", "darwin", "x64", "bcct", "bcct-darwin-x64"],
    ["win32-x64", "win32", "x64", "bcct.exe", "bcct-win32-x64.exe"],
    ["win32-arm64", "win32", "arm64", "bcct.exe", "bcct-win32-arm64.exe"],
  ])(
    "builds the %s package with os and cpu, no libc, and the binary of its asset",
    (name, os, cpu, binary, asset) => {
      project();
      build();

      const dir = join(
        root,
        "dist/npm",
        `@pedromondek/better-claude-code-telegram-${name}`,
      );

      expect(
        manifest(`@pedromondek/better-claude-code-telegram-${name}`),
      ).toMatchObject({
        name: `@pedromondek/better-claude-code-telegram-${name}`,
        version: VERSION,
        os: [os],
        cpu: [cpu],
        files: ["bin/"],
        repository: JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
          .repository,
      });
      expect(
        manifest(`@pedromondek/better-claude-code-telegram-${name}`),
      ).not.toHaveProperty("libc");
      expect(readFileSync(join(dir, "bin", binary), "utf8")).toBe(
        `binary ${asset}`,
      );
      expect(statSync(join(dir, "bin", binary)).mode & 0o777).toBe(0o755);
      expect(existsSync(join(dir, "LICENSE"))).toBe(true);
    },
  );

  it("refuses an asset whose hash is not the one of checksums.txt, building nothing", () => {
    project();
    writeFileSync(join(root, "assets/bcct-darwin-x64"), "tampered");

    expect(() => build()).toThrow(
      "bcct-darwin-x64 does not match the hash of 0.2.0 in checksums.txt",
    );
    expect(existsSync(join(root, "dist/npm"))).toBe(false);
  });

  it("refuses a missing asset", () => {
    project();
    rmSync(join(root, "assets/bcct-win32-arm64.exe"));

    expect(() => build()).toThrow(
      `bcct-win32-arm64.exe is missing from ${join(root, "assets")}`,
    );
  });

  it("refuses a checksums.txt without the hash of an asset of this version", () => {
    project();
    writeFileSync(
      join(root, CHECKSUMS_FILE),
      readFileSync(join(root, CHECKSUMS_FILE), "utf8").replace(
        /^0\.2\.0 bcct-linux-arm64 .*$/mu,
        "",
      ),
    );

    expect(() => build()).toThrow(
      "checksums.txt has no hash for bcct-linux-arm64 0.2.0",
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

    expect(() => build()).toThrow(
      "the version files disagree: npm run release:version -- check names them",
    );
  });

  it("replaces an earlier build in the output folder", () => {
    project();
    build();
    writeFileSync(join(root, "dist/npm/leftover"), "old");

    build();

    expect(existsSync(join(root, "dist/npm/leftover"))).toBe(false);
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

  it("builds the packages from the assets folder into the output folder and names them", () => {
    project();

    const result = runWith(["assets", "dist/npm"]);

    expect(result.code).toBe(0);
    expect(result.out[0]).toBe("✓ 7 packages of v0.2.0 in dist/npm:");
    expect(result.out).toContain("  @pedromondek/better-claude-code-telegram");
  });

  it("exits 1 with the reason", () => {
    project({ checksums: false });

    const result = runWith(["assets", "dist/npm"]);

    expect(result.code).toBe(1);
    expect(result.err[0]).toMatch(/^✗ /u);
  });

  it.each([[[]], [["assets"]], [["a", "b", "c"]]])(
    "a usage error exits 2 (%j)",
    (args) => {
      expect(runWith(args)).toEqual({
        code: 2,
        out: [],
        err: ["usage: npm run release:npm -- <assets folder> <output folder>"],
      });
    },
  );

  it("is the release:npm npm script", () => {
    const { scripts } = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    );

    expect(scripts["release:npm"]).toBe("node scripts/release-npm.mjs");
  });
});
