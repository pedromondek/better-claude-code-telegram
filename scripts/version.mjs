import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const VERSION_FILES = [
  "rust/Cargo.toml",
  "rust/Cargo.lock",
  "package.json",
  "package-lock.json",
  "plugins/telegram/package.json",
  "plugins/telegram/.claude-plugin/plugin.json",
  "plugins/telegram-hooks/.claude-plugin/plugin.json",
  "plugins/bcct/.claude-plugin/plugin.json",
];

const STAGES = ["alpha", "beta", "rc", "stable"];
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.([1-9]\d*))?$/;
const JSON_VERSION = /^( {2}"version": ")([^"]+)(")/m;
const LOCK_ROOT_PACKAGE = /^( {4}"": \{\n[\s\S]*?^ {6}"version": ")([^"]+)(")/m;
const CARGO_WORKSPACE_VERSION =
  /^(\[workspace\.package\]\n(?:(?!\[)[^\n]*\n)*?version = ")([^"]+)(")/m;
const CARGO_LOCK_VERSION = /^(name = "bcct"\nversion = ")([^"]+)(")/m;
const USAGE =
  "usage: npm run release:version -- check | set <version> | next <alpha|beta|rc|stable>";

export function parseVersion(text) {
  const match = VERSION_PATTERN.exec(text);

  if (!match) {
    throw new Error(`invalid version: ${text}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    stage: match[4] ?? null,
    number: match[5] === undefined ? null : Number(match[5]),
  };
}

function base({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

function isAfter(next, current) {
  return (
    (next.major - current.major ||
      next.minor - current.minor ||
      next.patch - current.patch) > 0
  );
}

export function nextVersion(current, stage, bumped) {
  if (!STAGES.includes(stage)) {
    throw new Error(`unknown stage: ${stage} (use alpha, beta, rc or stable)`);
  }

  const version = parseVersion(current);

  if (version.stage === null) {
    const target = parseVersion(bumped);

    if (!isAfter(target, version)) {
      throw new Error(
        `nothing to release after ${current} (to pick the version by hand, use set <version>)`,
      );
    }

    return stage === "stable" ? base(target) : `${base(target)}-${stage}.1`;
  }

  const from = STAGES.indexOf(version.stage);
  const to = STAGES.indexOf(stage);

  if (to < from) {
    throw new Error(`cannot go back from ${version.stage} to ${stage}`);
  }

  if (stage === "stable") {
    return base(version);
  }

  return `${base(version)}-${stage}.${to === from ? version.number + 1 : 1}`;
}

function patternsOf(file) {
  if (file === "rust/Cargo.toml") {
    return [CARGO_WORKSPACE_VERSION];
  }

  if (file === "rust/Cargo.lock") {
    return [CARGO_LOCK_VERSION];
  }

  if (file === "package-lock.json") {
    return [JSON_VERSION, LOCK_ROOT_PACKAGE];
  }

  return [JSON_VERSION];
}

function versionIn(root, file) {
  const text = readFileSync(join(root, file), "utf8");
  const versions = patternsOf(file).map((pattern) => pattern.exec(text)?.[2]);

  if (versions.some((version) => version === undefined)) {
    throw new Error(`no version found in ${file}`);
  }

  return versions;
}

export function readVersions(root) {
  return VERSION_FILES.flatMap((file) =>
    versionIn(root, file).map((version) => ({ file, version })),
  );
}

export function checkVersions(root) {
  const [reference, ...others] = readVersions(root);

  return others
    .filter(({ version }) => version !== reference.version)
    .map(({ file, version }) => ({ file, version }));
}

export function setVersion(root, version) {
  parseVersion(version);

  const updated = VERSION_FILES.map((file) => {
    const text = readFileSync(join(root, file), "utf8");

    return [
      file,
      patternsOf(file).reduce(
        (current, pattern) =>
          current.replace(
            pattern,
            (_, before, _old, after) => `${before}${version}${after}`,
          ),
        text,
      ),
    ];
  });

  for (const [file, text] of updated) {
    writeFileSync(join(root, file), text);
  }
}

function gitCliffBump(root) {
  const result = spawnSync(
    "sh",
    [join(root, "scripts", "mise-exec.sh"), "git-cliff", "--bumped-version"],
    { cwd: root, encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(
      `git-cliff could not compute the next version:\n${result.stderr.trim()}`,
    );
  }

  return result.stdout.trim().replace(/^v/, "");
}

export function run(args, { root, bumped, out, err }) {
  const [command, value] = args;

  try {
    if (command === "check" && value === undefined) {
      const differences = checkVersions(root);
      const reference = readVersions(root)[0];

      if (differences.length === 0) {
        out(`✓ every file is on ${reference.version}`);

        return 0;
      }

      err(
        `✗ the version differs from ${reference.file} (${reference.version}):`,
      );
      for (const { file, version } of differences) {
        err(`  ${file}: ${version}`);
      }

      return 1;
    }

    if (command === "set" && value !== undefined) {
      setVersion(root, value);
      out(`✓ version set to ${value}`);

      return 0;
    }

    if (command === "next" && value !== undefined) {
      const current = readVersions(root)[0].version;
      const stable = parseVersion(current).stage === null;

      out(nextVersion(current, value, stable ? bumped() : current));

      return 0;
    }
  } catch (error) {
    err(`✗ ${error instanceof Error ? error.message : String(error)}`);

    return 1;
  }

  err(USAGE);

  return 2;
}

const entryPoint = process.argv[1];

if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  const root = join(import.meta.dirname, "..");

  process.exitCode = run(process.argv.slice(2), {
    root,
    bumped: () => gitCliffBump(root),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
