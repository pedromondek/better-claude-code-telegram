import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_LOCALE, isLocale, type Locale } from "./i18n.ts";

export const CONFIG_FILE = "better-cc-telegram.json";
export const DEFAULT_DELAY_MINUTES = 4;
export const DEFAULT_INBOX_RETENTION_DAYS = 7;

export interface QuietHours {
  start: string;
  end: string;
}

type Env = Record<string, string | undefined>;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function nonEmpty(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

export function defaultAppDir(env: Env = process.env): string {
  return (
    nonEmpty(env.BETTER_CC_TELEGRAM_DIR) ??
    join(
      nonEmpty(env.CLAUDE_CONFIG_DIR) ?? join(homedir(), ".claude"),
      "better-claude-code-telegram",
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readConfig(appDir: string): Record<string, unknown> {
  try {
    const config: unknown = JSON.parse(
      readFileSync(join(appDir, CONFIG_FILE)).toString(),
    );

    return isRecord(config) ? config : {};
  } catch {
    return {};
  }
}

export function readDelayMinutes(
  appDir: string,
  env: Env = process.env,
): number {
  const fromEnv = Number(nonEmpty(env.BETTER_CC_TELEGRAM_DELAY_MS?.trim()));

  if (Number.isFinite(fromEnv) && fromEnv >= 0) {
    return fromEnv / 60_000;
  }

  const minutes = Number(readConfig(appDir).delayMinutes);

  return Number.isFinite(minutes) && minutes > 0
    ? minutes
    : DEFAULT_DELAY_MINUTES;
}

export function readLocale(appDir: string): Locale {
  const { language } = readConfig(appDir);

  return isLocale(language) ? language : DEFAULT_LOCALE;
}

function minutesOfDay(time: string): number | null {
  const match = TIME_PATTERN.exec(time);

  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function readQuietHours(appDir: string): QuietHours | null {
  const quiet = readConfig(appDir).quietHours;

  return isRecord(quiet) &&
    typeof quiet.start === "string" &&
    typeof quiet.end === "string" &&
    minutesOfDay(quiet.start) !== null &&
    minutesOfDay(quiet.end) !== null
    ? { start: quiet.start, end: quiet.end }
    : null;
}

export function readInboxRetentionDays(appDir: string): number | null {
  const config = readConfig(appDir);
  const days = config.inboxRetentionDays;

  if (days === null) return null;

  return typeof days === "number" && days > 0
    ? days
    : DEFAULT_INBOX_RETENTION_DAYS;
}

export function readTranscriptionSetting(appDir: string): unknown {
  const { transcription } = readConfig(appDir);

  return isRecord(transcription) ? transcription.model : null;
}

export function isQuietTime(
  date: Date,
  quietHours: QuietHours | null,
): boolean {
  if (!quietHours) return false;

  const start = minutesOfDay(quietHours.start) ?? 0;
  const end = minutesOfDay(quietHours.end) ?? 0;
  const current = date.getHours() * 60 + date.getMinutes();

  return start <= end
    ? current >= start && current < end
    : current >= start || current < end;
}

export function formatDelay(minutes: number): string {
  return minutes >= 1 && Number.isInteger(minutes)
    ? `${minutes} min`
    : `${Math.round(minutes * 60)} s`;
}
