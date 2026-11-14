#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

import { run } from "../shim.mjs";

const SHIM_DIR = join(import.meta.dirname, "..");
const CONFIG_FILE = "better-cc-telegram.json";
const APP_FOLDER = "better-claude-code-telegram";
const require = createRequire(import.meta.url);

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function appDir(env) {
  if (env.BETTER_CC_TELEGRAM_DIR) {
    return env.BETTER_CC_TELEGRAM_DIR;
  }

  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), APP_FOLDER);
}

function readConfig() {
  try {
    return JSON.parse(
      readText(join(appDir(process.env), CONFIG_FILE)) ?? "null",
    );
  } catch {
    return null;
  }
}

function readInstalled(packageName) {
  try {
    const folder = dirname(require.resolve(`${packageName}/package.json`));
    const binary = process.platform === "win32" ? "bcct.exe" : "bcct";

    return readFileSync(join(folder, "bin", binary));
  } catch {
    return null;
  }
}

async function download(url) {
  const response = await fetch(url, { redirect: "follow" });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function ask(question) {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
  }
}

function writeExecutable(bytes, name) {
  const folder = mkdtempSync(join(tmpdir(), "bcct-shim-"));
  const file = join(folder, name);

  writeFileSync(file, bytes, { mode: 0o755 });

  return file;
}

function removeExecutable(file) {
  rmSync(dirname(file), { recursive: true, force: true });
}

function spawn(binary, args) {
  const result = spawnSync(binary, args, { stdio: "inherit" });

  return result.status ?? 1;
}

const { version } = JSON.parse(
  readFileSync(join(SHIM_DIR, "package.json"), "utf8"),
);

process.exitCode = await run(process.argv.slice(2), {
  version,
  platform: process.platform,
  arch: process.arch,
  env: process.env,
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  readConfig,
  readChecksums: () => readText(join(SHIM_DIR, "checksums.txt")) ?? "",
  readInstalled,
  download,
  ask,
  writeExecutable,
  removeExecutable,
  spawn,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
