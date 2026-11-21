import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { format } from "prettier";

export const NOW = 1_700_000_000_123;
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FIXED_CLOCK = `--import=data:text/javascript,Date.now=()=>${NOW}`;

const FIXTURES_DIR = join(
  REPO_ROOT,
  "rust",
  "crates",
  "bcct",
  "tests",
  "fixtures",
);

export function substitute(value, root) {
  return typeof value === "string"
    ? value.replaceAll("{root}", root).replaceAll("{repo}", REPO_ROOT)
    : value;
}

export function placeholders(text, root) {
  return text.replaceAll(root, "{root}").replaceAll(REPO_ROOT, "{repo}");
}

function bodyOf(spec, root) {
  if (typeof spec === "string") return Buffer.from(substitute(spec, root));
  if (spec.bytes !== undefined) return Buffer.from(spec.bytes);

  return Buffer.from(substitute(spec.content ?? "", root));
}

function ensureFolder(root, folder) {
  let current = root;

  for (const part of relative(root, folder).split("/").filter(Boolean)) {
    current = join(current, part);

    try {
      lstatSync(current);
    } catch {
      mkdirSync(current);
      chmodSync(current, 0o750);
    }
  }
}

export function materialize(root, files) {
  for (const [path, spec] of Object.entries(files)) {
    const target = join(root, path);

    if (path.endsWith("/")) {
      ensureFolder(root, target);
      continue;
    }

    ensureFolder(root, dirname(target));
    writeFileSync(target, bodyOf(spec, root));
    chmodSync(
      target,
      typeof spec === "object" && spec.mode ? spec.mode : 0o600,
    );
  }
}

export function snapshot(root) {
  const out = {};

  function walk(folder) {
    for (const name of readdirSync(folder).toSorted()) {
      const full = join(folder, name);
      const path = relative(root, full);
      const stats = lstatSync(full);
      const mode = (stats.mode & 0o777).toString(8);

      if (stats.isDirectory()) {
        out[`${path}/`] = { mode };
        walk(full);
      } else {
        out[path] = {
          content: placeholders(readFileSync(full).toString("utf8"), root),
          mode,
        };
      }
    }
  }

  walk(root);

  return out;
}

export function withRoot(run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bcct-fixture-")));
  const previousHome = process.env.HOME;

  process.env.HOME = join(root, "home");

  try {
    return run(root);
  } finally {
    process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}

export function resolveEnv(env, root) {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([, value]) => value !== null)
      .map(([key, value]) => [key, substitute(value, root)]),
  );
}

export function withProcessEnv(env, run) {
  const previous = { ...process.env };

  for (const key of Object.keys(process.env)) {
    if (key !== "HOME") delete process.env[key];
  }

  Object.assign(process.env, env);

  try {
    return run();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];

    Object.assign(process.env, previous);
  }
}

export function attempt(run) {
  try {
    return { threw: false, value: run() };
  } catch {
    return { threw: true, value: null };
  }
}

function escapeLineSeparators(source) {
  return source.replaceAll(
    /[\u{2028}\u{2029}]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16)}`,
  );
}

export async function writeFixture(name, fixture) {
  const formatted = await format(JSON.stringify(fixture), { parser: "json" });

  mkdirSync(FIXTURES_DIR, { recursive: true });
  writeFileSync(join(FIXTURES_DIR, name), escapeLineSeparators(formatted));
}
