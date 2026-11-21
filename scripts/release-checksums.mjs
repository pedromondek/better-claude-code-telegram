import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { TARGETS } from "./release-binary.mjs";
import { CHECKSUMS_FILE } from "./release-order.mjs";
import { checkVersions, readVersions } from "./version.mjs";

const USAGE = "usage: npm run release:checksums -- <assets folder>";
const HEADER = "# version asset sha256";

function readAsset(assetsDir, file) {
  const path = join(assetsDir, file);

  if (!existsSync(path)) {
    throw new Error(`${file} is missing from ${assetsDir}`);
  }

  return readFileSync(path);
}

function checkedLine(assetsDir, version, asset) {
  const binary = readAsset(assetsDir, asset);
  const [recorded, named] = readAsset(assetsDir, `${asset}.sha256`)
    .toString("utf8")
    .trim()
    .split(/\s+/u);

  if (named !== asset) {
    throw new Error(`${asset}.sha256 names ${named}, not ${asset}`);
  }

  const actual = createHash("sha256").update(binary).digest("hex");

  if (actual !== recorded) {
    throw new Error(`${asset} does not match ${asset}.sha256`);
  }

  return `${version} ${asset} ${actual}`;
}

export function appendChecksums({ root, assetsDir }) {
  if (checkVersions(root).length > 0) {
    throw new Error(
      "the version files disagree: npm run release:version -- check names them",
    );
  }

  const version = readVersions(root)[0].version;
  const file = join(root, CHECKSUMS_FILE);
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";

  if (current.split("\n").some((line) => line.split(/\s+/u)[0] === version)) {
    throw new Error(
      `checksums.txt already has lines for ${version}; the file only grows`,
    );
  }

  const lines = TARGETS.map(({ asset }) =>
    checkedLine(assetsDir, version, asset),
  );

  if (current === "") {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${HEADER}\n`);
  } else if (!current.endsWith("\n")) {
    appendFileSync(file, "\n");
  }

  appendFileSync(file, `${lines.join("\n")}\n`);

  return TARGETS.map(({ asset }) => asset);
}

export function run(args, { root, out, err }) {
  if (args.length !== 1) {
    err(USAGE);

    return 2;
  }

  try {
    const assets = appendChecksums({
      root,
      assetsDir: resolve(root, args[0]),
    });

    out(
      `✓ ${assets.length} lines of v${readVersions(root)[0].version} added to ${CHECKSUMS_FILE}`,
    );

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
