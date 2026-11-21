import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_FILE = "better-cc-telegram.json";
export const HEALTH_FILE = "health.json";
export const LAUNCH_FILE = "launch.json";
export const PREVIOUS_STATUSLINE_FILE = "statusline-previous.json";
export const DEFAULT_DELAY_MINUTES = 4;
export const DEFAULT_INBOX_RETENTION_DAYS = 7;
export const LOCALES = ["en-us", "pt-br"];
export const DEFAULT_LOCALE = "en-us";

export function telegramStateDir(env = process.env) {
  return (
    env.TELEGRAM_STATE_DIR ||
    join(
      env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
      "channels",
      "telegram",
    )
  );
}

export function defaultAppDir(env = process.env) {
  return (
    env.BETTER_CC_TELEGRAM_DIR ||
    join(
      env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
      "better-claude-code-telegram",
    )
  );
}

export function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function readConfig(appDir) {
  const config = readJsonFile(join(appDir, CONFIG_FILE));

  return config && typeof config === "object" && !Array.isArray(config)
    ? config
    : {};
}

export function readLocale(appDir) {
  const { language } = readConfig(appDir);

  return LOCALES.includes(language) ? language : DEFAULT_LOCALE;
}
