import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

export const STRYKER_TEMP_ROOT = ".stryker-tmp";

const RUN_DIR_PATTERN = /^run-(\d+)$/;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

export function runDirFor(pid) {
  return path.join(STRYKER_TEMP_ROOT, `run-${pid}`);
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function staleRunDirs(names, isAlive = isProcessAlive) {
  return names.filter((name) => {
    const match = RUN_DIR_PATTERN.exec(name);

    return match !== null && !isAlive(Number(match[1]));
  });
}

export function isolatedArgs(args, runDir) {
  return [...args, "--tempDirName", runDir, "--cleanTempDir", "always"];
}

export const STRYKER_TIMEZONE = "UTC";

export function isolatedEnv(env, runDir, cwd = process.cwd()) {
  return {
    ...env,
    TMPDIR: path.resolve(cwd, runDir, "tmp"),
    TZ: STRYKER_TIMEZONE,
  };
}

export function strykerBin() {
  return process.platform === "win32"
    ? "node_modules\\.bin\\stryker.cmd"
    : "node_modules/.bin/stryker";
}

function removeStaleRunDirs() {
  let names;
  try {
    names = readdirSync(STRYKER_TEMP_ROOT);
  } catch {
    return;
  }

  for (const name of staleRunDirs(names)) {
    rmSync(path.join(STRYKER_TEMP_ROOT, name), {
      recursive: true,
      force: true,
    });
  }
}

export function runStryker(args, { stdio = "inherit" } = {}) {
  removeStaleRunDirs();

  const runDir = runDirFor(process.pid);
  mkdirSync(path.join(runDir, "tmp"), { recursive: true });

  const child = spawn(strykerBin(), isolatedArgs(args, runDir), {
    stdio,
    env: isolatedEnv(process.env, runDir),
  });
  const forward = (signal) => child.kill(signal);
  for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);

  return new Promise((resolve) => {
    child.on("close", (code) => {
      for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
      rmSync(runDir, { recursive: true, force: true });
      resolve(code ?? 1);
    });
  });
}

if (import.meta.main) {
  process.exitCode = await runStryker(process.argv.slice(2));
}
