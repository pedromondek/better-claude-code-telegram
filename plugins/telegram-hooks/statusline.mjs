#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { messagesFor } from "./lib/messages.mjs";
import {
  HEALTH_FILE,
  LAUNCH_FILE,
  PREVIOUS_STATUSLINE_FILE,
  defaultAppDir,
  readJsonFile,
  readLocale,
} from "./lib/state.mjs";

const RESET = "\u001B[0m";
const GREEN = "\u001B[32m";
const RED = "\u001B[31m";
const YELLOW = "\u001B[33m";

export const TELEGRAM_HEALTH_TTL_MS = 15_000;
export const TELEGRAM_LAUNCH_GRACE_MS = 60_000;

function timeOf(data, key) {
  return data && typeof data === "object" ? Number(data[key]) : Number.NaN;
}

export function telegramSegment(env = process.env, now = Date.now()) {
  const appDir = defaultAppDir(env);
  const messages = messagesFor(readLocale(appDir));
  const isTelegramInstance = env.BETTER_CC_TELEGRAM === "1";
  const role = isTelegramInstance
    ? messages.statusMain
    : messages.statusSecondary;
  const health = readJsonFile(join(appDir, HEALTH_FILE));
  const fresh = now - timeOf(health, "checkedAt") < TELEGRAM_HEALTH_TTL_MS;

  if (fresh && health.polling) {
    return `${GREEN}${messages.statusConnected(role)}${RESET}`;
  }

  if (!fresh && !isTelegramInstance) return null;

  const launching =
    now - timeOf(readJsonFile(join(appDir, LAUNCH_FILE)), "launchedAt") <
    TELEGRAM_LAUNCH_GRACE_MS;

  return launching
    ? `${YELLOW}${messages.statusConnecting(role)}${RESET}`
    : `${RED}${messages.statusDown(role)}${RESET}`;
}

export function joinStatusline(previousOutput, segment) {
  const rows = previousOutput.replace(/\n+$/, "");

  if (!segment) return rows;

  return rows ? `${rows} │ ${segment}` : segment;
}

function previousStatuslineOutput(input) {
  const previous = readJsonFile(
    join(defaultAppDir(), PREVIOUS_STATUSLINE_FILE),
  );

  if (typeof previous?.command !== "string") return "";

  return (
    spawnSync("sh", ["-c", previous.command], { input, encoding: "utf8" })
      .stdout ?? ""
  );
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const segment = telegramSegment();

  process.stdout.write(
    process.argv[2] === "--after-previous"
      ? joinStatusline(previousStatuslineOutput(readStdin()), segment)
      : (segment ?? ""),
  );
}
