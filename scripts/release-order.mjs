import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { STAGES, parseVersion } from "./version.mjs";

export const FIRST_BASE = "0.1.0";
export const CHECKSUMS_FILE = "plugins/telegram-hooks/checksums.txt";

const RELEASES_DIR = "docs/releases";
const NO_STABLE = "0.0.0";
const PUBLIC_SOURCES = [
  ["tags", "the tags"],
  ["releases", "the Releases"],
  ["npm", "npm"],
];

function isVersion(text) {
  try {
    parseVersion(text);

    return true;
  } catch {
    return false;
  }
}

function base({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

function stageRank(version) {
  return version.stage === null ? STAGES.length : STAGES.indexOf(version.stage);
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);

  return (
    a.major - b.major ||
    a.minor - b.minor ||
    a.patch - b.patch ||
    stageRank(a) - stageRank(b) ||
    (a.number ?? 0) - (b.number ?? 0)
  );
}

function highestOf(versions) {
  return versions.toSorted(compareVersions).at(-1) ?? null;
}

function nextBases(stable) {
  const { major, minor, patch } = parseVersion(stable);

  return [
    `${major}.${minor}.${patch + 1}`,
    `${major}.${minor + 1}.0`,
    `${major + 1}.0.0`,
  ];
}

function bumpOf(from, to) {
  const a = parseVersion(from);
  const b = parseVersion(to);

  if (a.major !== b.major) {
    return "major";
  }

  return a.minor === b.minor ? "patch" : "minor";
}

export function checkOrder(version, released) {
  const target = parseVersion(version);
  const highest = highestOf(released);
  const stable = highestOf(
    released.filter((item) => parseVersion(item).stage === null),
  );
  const open =
    highest !== null && parseVersion(highest).stage !== null
      ? base(parseVersion(highest))
      : null;
  const allowed =
    open === null
      ? stable === null
        ? [FIRST_BASE]
        : nextBases(stable)
      : [open];
  const bump = bumpOf(stable ?? NO_STABLE, base(target));
  const result = (problem) => ({
    problem,
    bump,
    opensBase: open === null,
    approval: bump !== "patch" && (open === null || target.stage === null),
  });

  if (released.includes(version)) {
    return result(`v${version} already exists`);
  }

  if (highest !== null && compareVersions(version, highest) <= 0) {
    return result(
      `v${version} does not come after v${highest}, the highest version released`,
    );
  }

  if (!allowed.includes(base(target))) {
    return result(
      `v${version} skips a version: the next one has the base ${allowed.join(", ")}`,
    );
  }

  return result(null);
}

function list(items, words) {
  return items.length === 1
    ? words(items[0])
    : `${items.slice(0, -1).map(words).join(", ")} and ${words(items.at(-1))}`;
}

export function releasedVersions(sources) {
  const all = Object.values(sources).flat().filter(isVersion);
  const versions = [...new Set(all)].toSorted(compareVersions);
  const warnings = versions.flatMap((version) => {
    const has = PUBLIC_SOURCES.filter(([key]) =>
      sources[key].includes(version),
    );
    const lacks = PUBLIC_SOURCES.filter(
      ([key]) => !sources[key].includes(version),
    );

    if (has.length === 0 || lacks.length === 0) {
      return [];
    }

    return [
      `v${version} is in ${list(has, ([, name]) => name)}, but not in ${list(lacks, ([, name]) => name)}`,
    ];
  });

  return { versions, warnings };
}

function notesVersions(root) {
  const dir = join(root, RELEASES_DIR);

  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      readdirSync(join(dir, entry.name))
        .filter((file) => file.endsWith(".md"))
        .map((file) => {
          const name = file.slice(0, -".md".length);

          return name === "stable" ? entry.name : `${entry.name}-${name}`;
        }),
    )
    .filter(isVersion);
}

function checksumsVersions(root) {
  const file = join(root, CHECKSUMS_FILE);

  if (!existsSync(file)) {
    return [];
  }

  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .map((line) => line.trim().split(/\s+/u)[0])
    .filter(isVersion);
}

export function ledgerVersions(root) {
  return [...new Set([...notesVersions(root), ...checksumsVersions(root)])];
}
