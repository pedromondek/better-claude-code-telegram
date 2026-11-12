import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const CARGO_MANIFEST = "rust/Cargo.toml";
const MARKETPLACE = ".claude-plugin/marketplace.json";
const PACKAGE_MANIFESTS = ["package.json", "plugins/telegram/package.json"];
const LOCKFILE = "package-lock.json";

function read(file) {
  return readFileSync(join(ROOT, file), "utf8");
}

function readJson(file) {
  return JSON.parse(read(file));
}

function cargoVersion() {
  const section =
    /^\[workspace\.package\]\n([\s\S]*?)(?:^\[|$(?![\s\S]))/m.exec(
      read(CARGO_MANIFEST),
    )?.[1];

  return /^version = "([^"]+)"$/m.exec(section ?? "")?.[1];
}

function pluginManifests() {
  return readJson(MARKETPLACE).plugins.map(
    ({ source }) => `${source.replace(/^\.\//, "")}/.claude-plugin/plugin.json`,
  );
}

describe("project version", () => {
  it("is one version in the binary, the npm packages and every plugin of the marketplace", () => {
    const version = cargoVersion();
    const manifests = [...PACKAGE_MANIFESTS, ...pluginManifests()];

    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifests).toEqual(
      expect.arrayContaining([
        "plugins/telegram/.claude-plugin/plugin.json",
        "plugins/telegram-hooks/.claude-plugin/plugin.json",
        "plugins/bcct/.claude-plugin/plugin.json",
      ]),
    );
    expect(
      Object.fromEntries(
        manifests.map((file) => [file, readJson(file).version]),
      ),
    ).toEqual(Object.fromEntries(manifests.map((file) => [file, version])));
  });

  it("keeps the lockfile of the root on the same version", () => {
    const lock = readJson(LOCKFILE);

    expect([lock.version, lock.packages[""].version]).toEqual([
      cargoVersion(),
      cargoVersion(),
    ]);
  });

  it("leaves the version out of the marketplace entries, since the one of plugin.json wins", () => {
    for (const entry of readJson(MARKETPLACE).plugins) {
      expect(entry).not.toHaveProperty("version");
    }
  });
});
