import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MARKETPLACE_FILE = ".claude-plugin/marketplace.json";
const UPSTREAM_PLUGINS = new Set(["plugins/telegram"]);
const MARKETPLACE_ROOT = ".";

export function pluginTargets(marketplace) {
  const plugins = marketplace.plugins.map(({ source }) => {
    const path = source.replace(/^\.\//u, "");

    return { path, strict: !UPSTREAM_PLUGINS.has(path) };
  });

  return [...plugins, { path: MARKETPLACE_ROOT, strict: false }];
}

function report(result) {
  return [result.stdout, result.stderr]
    .filter((text) => typeof text === "string" && text.trim() !== "")
    .join("\n")
    .trimEnd();
}

export function validatePlugins({ marketplace, run, env, log }) {
  let failed = false;

  for (const { path, strict } of pluginTargets(marketplace)) {
    const result = run([
      "plugin",
      "validate",
      ...(strict ? ["--strict"] : []),
      path,
    ]);

    if (result.error?.code === "ENOENT") {
      if (env.CI) {
        log("✗ claude is not installed: the workflow has to install it");
        return 1;
      }

      log("⚠ claude is not installed: plugin manifests not validated");
      return 0;
    }

    if (result.status !== 0) {
      failed = true;
      log(`✗ ${path}`);
      log(report(result));
    }
  }

  return failed ? 1 : 0;
}

export function withIsolatedConfig(action, { env, makeDir, removeDir, spawn }) {
  const dir = makeDir();

  try {
    return action((args) =>
      spawn("claude", args, {
        encoding: "utf8",
        env: { ...env, CLAUDE_CONFIG_DIR: dir },
      }),
    );
  } finally {
    removeDir(dir);
  }
}

function main() {
  process.exitCode = withIsolatedConfig(
    (run) =>
      validatePlugins({
        marketplace: JSON.parse(readFileSync(MARKETPLACE_FILE, "utf8")),
        run,
        env: process.env,
        log: (line) => console.log(line),
      }),
    {
      env: process.env,
      makeDir: () => mkdtempSync(join(tmpdir(), "bcct-claude-")),
      removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
      spawn: spawnSync,
    },
  );
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main();
}
