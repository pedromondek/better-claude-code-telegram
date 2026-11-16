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

export const DELAY_KINDS = ["questions", "permissions", "waiting"] as const;

export type DelayKind = (typeof DELAY_KINDS)[number];

export function kindMinutes(
  config: Record<string, unknown>,
  kind: DelayKind | undefined,
): number | null {
  const { delays } = config;

  if (kind === undefined || !isRecord(delays)) return null;

  const minutes = delays[kind];

  return typeof minutes === "number" && minutes >= 0 && minutes < Infinity
    ? minutes
    : null;
}

export function readDelayMinutes(
  appDir: string,
  env: Env = process.env,
  kind?: DelayKind,
): number {
  const fromEnv = Number(nonEmpty(env.BETTER_CC_TELEGRAM_DELAY_MS?.trim()));

  if (Number.isFinite(fromEnv) && fromEnv >= 0) {
    return fromEnv / 60_000;
  }

  const config = readConfig(appDir);
  const ownMinutes = kindMinutes(config, kind);

  if (ownMinutes !== null) return ownMinutes;

  const raw = config.delayMinutes;
  const minutes = Number(raw);
  const rightAway = raw === 0 || raw === "0";

  return Number.isFinite(minutes) && (minutes > 0 || rightAway)
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

export const VISUAL_MODES = ["off", "prints", "video"] as const;

export type VisualMode = (typeof VISUAL_MODES)[number];

export interface Visuals {
  visuals: VisualMode;
  review: boolean;
}

function isVisualMode(value: unknown): value is VisualMode {
  return VISUAL_MODES.some((mode) => mode === value);
}

export function readVisuals(appDir: string): Visuals {
  const { visuals, visualReview } = readConfig(appDir);

  return {
    visuals: isVisualMode(visuals) ? visuals : "off",
    review: visualReview !== false,
  };
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
  const totalSeconds = Math.round(minutes * 60);
  const wholeMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (wholeMinutes === 0) return `${seconds} s`;

  return seconds === 0
    ? `${wholeMinutes} min`
    : `${wholeMinutes} min ${seconds} s`;
}
