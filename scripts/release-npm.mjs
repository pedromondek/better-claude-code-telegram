import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

import { COMMAND, PACKAGE } from "../npm/shim/shim.constants.mjs";
import { expectedHash } from "../npm/shim/shim.mjs";
import { TARGETS } from "./release-binary.mjs";
import { CHECKSUMS_FILE } from "./release-order.mjs";
import { binaryFileName } from "./release.constants.mjs";
import { checkVersions, readVersions } from "./version.mjs";

const USAGE = "usage: npm run release:npm -- <assets folder> <output folder>";
const SHIM_BIN = `bin/${COMMAND}.mjs`;
const SHIM_SOURCES = [
  ["shim.mjs", "npm/shim/shim.mjs"],
  ["shim.constants.mjs", "npm/shim/shim.constants.mjs"],
  [SHIM_BIN, `npm/shim/${SHIM_BIN}`],
];
const LEGAL_FILES = ["LICENSE", "NOTICE"];
const NPM_ARCH = { x86_64: "x64", aarch64: "arm64" };
const META_FIELDS = [
  "description",
  "keywords",
  "homepage",
  "bugs",
  "repository",
  "license",
  "author",
];

export function platformOf(target) {
  const cpu = NPM_ARCH[target.arch];

  return {
    ...target,
    cpu,
    packageName: `${PACKAGE}-${target.os}-${cpu}`,
    binary: binaryFileName(target.os),
  };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function copyLegal(root, dir) {
  for (const file of LEGAL_FILES) {
    copyFileSync(join(root, file), join(dir, file));
  }
}

function checkedAssets({ assetsDir, version, checksums }) {
  return TARGETS.map(platformOf).map((platform) => {
    const path = join(assetsDir, platform.asset);

    if (!existsSync(path)) {
      throw new Error(`${platform.asset} is missing from ${assetsDir}`);
    }

    const expected = expectedHash(checksums, version, platform.asset);

    if (expected === null) {
      throw new Error(
        `checksums.txt has no hash for ${platform.asset} ${version}`,
      );
    }

    const actual = createHash("sha256")
      .update(readFileSync(path))
      .digest("hex");

    if (actual !== expected) {
      throw new Error(
        `${platform.asset} does not match the hash of ${version} in checksums.txt`,
      );
    }

    return { ...platform, path };
  });
}

export function buildPackages({ root, assetsDir, outDir }) {
  if (checkVersions(root).length > 0) {
    throw new Error(
      "the version files disagree: npm run release:version -- check names them",
    );
  }

  const version = readVersions(root)[0].version;
  const rootManifest = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  const meta = Object.fromEntries(
    META_FIELDS.map((field) => [field, rootManifest[field]]),
  );
  const checksumsPath = join(root, CHECKSUMS_FILE);
  const checksums = existsSync(checksumsPath)
    ? readFileSync(checksumsPath, "utf8")
    : "";
  const platforms = checkedAssets({ assetsDir, version, checksums });

  rmSync(outDir, { recursive: true, force: true });

  const shimDir = join(outDir, PACKAGE);

  mkdirSync(join(shimDir, "bin"), { recursive: true });
  for (const [published, source] of SHIM_SOURCES) {
    copyFileSync(join(root, source), join(shimDir, published));
  }
  copyFileSync(checksumsPath, join(shimDir, "checksums.txt"));
  copyLegal(root, shimDir);
  writeJson(join(shimDir, "package.json"), {
    name: PACKAGE,
    version,
    ...meta,
    type: "module",
    engines: rootManifest.engines,
    bin: { [COMMAND]: SHIM_BIN },
    files: ["bin/", "shim.mjs", "shim.constants.mjs", "checksums.txt"],
    optionalDependencies: Object.fromEntries(
      platforms.map(({ packageName }) => [packageName, version]),
    ),
  });

  for (const platform of platforms) {
    const dir = join(outDir, platform.packageName);
    const binary = join(dir, "bin", platform.binary);

    mkdirSync(join(dir, "bin"), { recursive: true });
    copyFileSync(platform.path, binary);
    chmodSync(binary, 0o755);
    copyLegal(root, dir);
    writeJson(join(dir, "package.json"), {
      name: platform.packageName,
      version,
      ...meta,
      description: `The bcct binary of ${PACKAGE} for ${platform.os} ${platform.cpu}.`,
      os: [platform.os],
      cpu: [platform.cpu],
      files: ["bin/"],
    });
  }

  return [PACKAGE, ...platforms.map(({ packageName }) => packageName)];
}

export function run(args, { root, out, err }) {
  if (args.length !== 2) {
    err(USAGE);

    return 2;
  }

  const [assets, output] = args;
  const outDir = resolve(root, output);

  try {
    const names = buildPackages({
      root,
      assetsDir: resolve(root, assets),
      outDir,
    });

    out(
      `✓ ${names.length} packages of v${readVersions(root)[0].version} in ${relative(root, outDir)}:`,
    );
    for (const name of names) {
      out(`  ${name}`);
    }

    return 0;
  } catch (error) {
    err(`✗ ${error instanceof Error ? error.message : String(error)}`);

    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = run(process.argv.slice(2), {
    root: join(import.meta.dirname, ".."),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
