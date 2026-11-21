import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { RUST_TARGET_DIR, binaryFileName } from "./release.constants.mjs";

export const DEFAULT_BUILD_MEMORY = "5G";
export const BUILD_SWAP = "1G";
export const DEFAULT_BUILD_JOBS = "3";
export const LAUNCHER_ONLY_PLUGIN = "telegram";

const MARKETPLACE_FILE = ".claude-plugin/marketplace.json";
const BUILD_SCRIPT = ["run", "--silent", "rust:build"];
const USAGE = "Usage: node scripts/dev-install.mjs <binary|plugins|install>";

export function builtBinary(env, platform) {
  return join(
    env.CARGO_TARGET_DIR ?? RUST_TARGET_DIR,
    "release",
    binaryFileName(platform),
  );
}

function report(result) {
  return [result.stdout, result.stderr]
    .filter((text) => typeof text === "string" && text.trim() !== "")
    .join("\n")
    .trimEnd();
}

function hasSystemdRun(run, platform) {
  return (
    platform === "linux" &&
    run("systemd-run", ["--user", "--quiet", "--wait", "--collect", "true"])
      .status === 0
  );
}

function build({ env, platform, cwd, run }) {
  const jobs = env.CARGO_BUILD_JOBS ?? DEFAULT_BUILD_JOBS;

  if (!hasSystemdRun(run, platform)) {
    return run("npm", BUILD_SCRIPT, {
      env: { ...env, CARGO_BUILD_JOBS: jobs },
      stdio: "inherit",
    });
  }

  const passed = [
    ["PATH", env.PATH],
    ["HOME", env.HOME],
    ["CARGO_TARGET_DIR", env.CARGO_TARGET_DIR],
    ["CARGO_BUILD_JOBS", jobs],
  ].filter(([, value]) => value !== undefined);

  return run(
    "systemd-run",
    [
      "--user",
      "--wait",
      "--collect",
      "-P",
      "-p",
      `MemoryMax=${env.BCCT_BUILD_MEMORY ?? DEFAULT_BUILD_MEMORY}`,
      "-p",
      `MemorySwapMax=${BUILD_SWAP}`,
      `--working-directory=${cwd}`,
      ...passed.flatMap(([name, value]) => ["-E", `${name}=${value}`]),
      "npm",
      ...BUILD_SCRIPT,
    ],
    { stdio: "inherit" },
  );
}

export function devBinary({ env, platform, cwd, run, readFile, log }) {
  if (build({ env, platform, cwd, run }).status !== 0) {
    log("✗ build failed");
    return 1;
  }

  const binary = builtBinary(env, platform);
  const sha256 = createHash("sha256").update(readFile(binary)).digest("hex");
  const installed = run(binary, [
    "self-install",
    binary,
    "--sha256",
    sha256,
    "--from",
    "manual",
  ]);

  if (installed.status !== 0) {
    log("✗ self-install failed");
    log(report(installed));
    return 1;
  }

  const [version] = report(run(binary, ["--version"])).split("\n");

  log(`✔ ${version} installed from ${binary} (sha256 ${sha256})`);
  return 0;
}

export function devPlugins({ marketplace, run, log }) {
  const plugin = (name) => `${name}@${marketplace.name}`;
  const claude = (args) => run("claude", ["plugin", ...args]);

  for (const { name } of marketplace.plugins) {
    if (claude(["uninstall", plugin(name)]).error?.code === "ENOENT") {
      log("✗ claude is not installed");
      return 1;
    }

    const installed = claude(["install", plugin(name)]);

    if (installed.status !== 0) {
      log(`✗ ${plugin(name)}`);
      log(report(installed));
      return 1;
    }
  }

  const disabled = claude(["disable", plugin(LAUNCHER_ONLY_PLUGIN)]);

  if (disabled.status !== 0) {
    log(`✗ ${plugin(LAUNCHER_ONLY_PLUGIN)} did not turn off`);
    log(report(disabled));
    return 1;
  }

  log(
    `✔ plugins reinstalled: ${marketplace.plugins.map(({ name }) => name).join(", ")}`,
  );
  log(
    `✔ ${plugin(LAUNCHER_ONLY_PLUGIN)} off (only claude --telegram turns it on)`,
  );
  log(
    "  → reopen claude --telegram, or run /reload-plugins and /mcp reconnect plugin:telegram:telegram (the channel server only restarts on reconnect)",
  );
  return 0;
}

export function runDev(step, { binary, plugins, log }) {
  if (step === "binary") return binary();
  if (step === "plugins") return plugins();
  if (step === "install") return binary() === 0 ? plugins() : 1;

  log(USAGE);
  return 1;
}

function main() {
  const run = (command, args, options = {}) =>
    spawnSync(command, args, { encoding: "utf8", ...options });

  process.exitCode = runDev(process.argv[2], {
    binary: () =>
      devBinary({
        env: process.env,
        platform: process.platform,
        cwd: process.cwd(),
        run,
        readFile: (path) => readFileSync(path),
        log: (line) => console.log(line),
      }),
    plugins: () =>
      devPlugins({
        marketplace: JSON.parse(readFileSync(MARKETPLACE_FILE, "utf8")),
        run,
        log: (line) => console.log(line),
      }),
    log: (line) => console.error(line),
  });
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main();
}
